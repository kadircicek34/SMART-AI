import crypto from 'node:crypto';
import { config } from '../config.js';
import { collectTenantMemories, readOnlyMemoryStore } from '../memory/store.js';
import { collectTenantChunks, readOnlyRagStore } from '../rag/store.js';
import { readJsonFileSync, writeJsonFileAtomic } from '../persistence/json-file.js';
import { createTimeoutSignal, throwIfAborted } from '../utils/abort.js';
import type { ToolInput, ToolResult } from './types.js';

type RuntimeCorpus = 'memory' | 'rag';

type RuntimeSearchDocument = {
  documentKey: string;
  corpus: RuntimeCorpus;
  title: string;
  source: string;
  citation: string;
  text: string;
  updatedAt: number;
  lexicalScore: number;
};

type EmbeddingCacheEntry = {
  model: string;
  contentHash: string;
  embedding: number[];
  updatedAt: number;
  corpus: RuntimeCorpus;
  title: string;
  citation: string;
  excerpt: string;
};

type EmbeddingCacheFile = {
  version: 1;
  entries: Record<string, EmbeddingCacheEntry>;
};

type RankedDocument = RuntimeSearchDocument & {
  semanticScore: number;
  score: number;
};

type EmbeddingRequest = {
  texts: string[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'for',
  'to',
  'of',
  'in',
  'on',
  'at',
  'is',
  'are',
  'be',
  'with',
  'as',
  'by',
  'from',
  'that',
  'this',
  'it',
  'its',
  'into',
  'about',
  'we',
  'you',
  'your',
  'our',
  'their',
  'they',
  'he',
  'she',
  'them',
  've',
  'de',
  'da',
  'bir',
  'veya',
  'ile',
  'için',
  'olarak',
  'bu',
  'şu',
  'o',
  'mi',
  'mı',
  'mu',
  'mü',
  'çok',
  'az',
  'daha',
  'en',
  'gibi',
  'ama',
  'fakat',
  'ancak',
  've',
  'ya',
  'yada',
  'biz',
  'siz',
  'ben'
]);

const EMPTY_CACHE: EmbeddingCacheFile = {
  version: 1,
  entries: {}
};

const MAX_EMBED_BATCH_SIZE = 32;
let cacheQueue: Promise<unknown> = Promise.resolve();

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function tokenize(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9ğüşöçıİĞÜŞÖÇ]+/gi) ?? [])
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 1)
    .filter((token) => !STOP_WORDS.has(token));
}

function hashContent(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function computeLexicalScore(queryTokens: string[], document: RuntimeSearchDocument): number {
  if (queryTokens.length === 0) return 0;

  const haystack = `${document.title}\n${document.source}\n${document.text}`;
  const docTokens = tokenize(haystack);
  if (docTokens.length === 0) return 0;

  const frequency = new Map<string, number>();
  for (const token of docTokens) {
    frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }

  const queryUnique = new Set(queryTokens);
  let rawScore = 0;
  let matched = 0;

  for (const token of queryUnique) {
    const tf = (frequency.get(token) ?? 0) / docTokens.length;
    if (tf > 0) {
      matched += 1;
      rawScore += tf;
    }
  }

  const coverageBoost = queryUnique.size > 0 ? (matched / queryUnique.size) * 0.45 : 0;
  const phraseBoost = haystack.toLowerCase().includes(normalizeWhitespace(queryTokens.join(' ')).toLowerCase()) ? 0.12 : 0;

  return rawScore + coverageBoost + phraseBoost;
}

function normalizeScores(values: number[]): number[] {
  if (values.length === 0) return [];

  const min = Math.min(...values);
  const max = Math.max(...values);
  if (Math.abs(max - min) < 1e-9) {
    return values.map(() => (max > 0 ? 1 : 0));
  }

  return values.map((value) => (value - min) / (max - min));
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return 0;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (leftNorm <= 0 || rightNorm <= 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function buildEmbeddingInput(document: RuntimeSearchDocument): string {
  return truncate([document.title, document.source, document.text].filter(Boolean).join('\n'), config.tools.qmdEmbeddingFallbackMaxInputChars);
}

function loadEmbeddingCache(): EmbeddingCacheFile {
  const parsed = readJsonFileSync<EmbeddingCacheFile>(config.storage.qmdEmbeddingFallbackCacheFile);
  if (!parsed || parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
    return {
      version: 1,
      entries: {}
    };
  }

  return {
    version: 1,
    entries: parsed.entries
  };
}

function withCacheLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = cacheQueue.then(fn, fn);
  cacheQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

async function collectRuntimeDocuments(tenantId: string): Promise<RuntimeSearchDocument[]> {
  const [memories, chunks] = await Promise.all([
    readOnlyMemoryStore((store) => collectTenantMemories(store, tenantId)),
    readOnlyRagStore((store) => collectTenantChunks(store, tenantId))
  ]);

  const memoryDocs: RuntimeSearchDocument[] = memories.map((item) => ({
    documentKey: `memory:${item.memoryId}`,
    corpus: 'memory',
    title: `Memory / ${item.category}`,
    source: item.source || 'memory',
    citation: `memory://${tenantId}/${item.memoryId}`,
    text: [item.content, item.context, item.tags.join(' ')].filter(Boolean).join('\n'),
    updatedAt: item.updatedAt,
    lexicalScore: 0
  }));

  const ragDocs: RuntimeSearchDocument[] = chunks.map((chunk) => ({
    documentKey: `rag:${chunk.chunkId}`,
    corpus: 'rag',
    title: chunk.title || 'RAG Document',
    source: chunk.source || 'rag',
    citation: `rag://${tenantId}/${chunk.documentId}#${chunk.chunkId}`,
    text: chunk.text,
    updatedAt: chunk.createdAt,
    lexicalScore: 0
  }));

  return [...memoryDocs, ...ragDocs].sort((left, right) => right.updatedAt - left.updatedAt);
}

function rankCandidateDocuments(query: string, documents: RuntimeSearchDocument[], candidateLimit: number): RuntimeSearchDocument[] {
  const queryTokens = tokenize(query);

  return documents
    .map((document) => ({
      ...document,
      lexicalScore: computeLexicalScore(queryTokens, document)
    }))
    .sort((left, right) => {
      if (right.lexicalScore !== left.lexicalScore) {
        return right.lexicalScore - left.lexicalScore;
      }

      return right.updatedAt - left.updatedAt;
    })
    .slice(0, Math.max(1, candidateLimit));
}

async function requestOpenAiEmbeddings(params: EmbeddingRequest): Promise<number[][]> {
  const apiKey = config.tools.qmdEmbeddingFallbackOpenAiApiKey?.trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY missing for QMD embedding fallback.');
  }

  const baseUrl = config.tools.qmdEmbeddingFallbackOpenAiBaseUrl.replace(/\/$/, '');
  const response = await (params.fetchImpl ?? fetch)(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: config.tools.qmdEmbeddingFallbackModel,
      input: params.texts,
      encoding_format: 'float'
    }),
    signal: createTimeoutSignal(config.tools.qmdEmbeddingFallbackTimeoutMs, params.signal)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI embeddings request failed (${response.status}): ${truncate(body, 320)}`);
  }

  const json = (await response.json()) as {
    data?: Array<{
      index?: number;
      embedding?: number[];
    }>;
  };

  const data = Array.isArray(json.data) ? [...json.data] : [];
  data.sort((left, right) => (left.index ?? 0) - (right.index ?? 0));

  const embeddings = data.map((entry) => entry.embedding).filter((value): value is number[] => Array.isArray(value));
  if (embeddings.length !== params.texts.length) {
    throw new Error(`OpenAI embeddings returned ${embeddings.length} vectors for ${params.texts.length} inputs.`);
  }

  return embeddings;
}

async function resolveDocumentEmbeddings(params: {
  documents: RuntimeSearchDocument[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<Map<string, number[]>> {
  return withCacheLock(async () => {
    const cache = loadEmbeddingCache();
    const embeddings = new Map<string, number[]>();
    const pending: Array<{
      document: RuntimeSearchDocument;
      contentHash: string;
      input: string;
    }> = [];

    for (const document of params.documents) {
      const input = buildEmbeddingInput(document);
      const contentHash = hashContent(input);
      const cacheEntry = cache.entries[document.documentKey];

      if (
        cacheEntry &&
        cacheEntry.model === config.tools.qmdEmbeddingFallbackModel &&
        cacheEntry.contentHash === contentHash &&
        Array.isArray(cacheEntry.embedding)
      ) {
        embeddings.set(document.documentKey, cacheEntry.embedding);
        continue;
      }

      pending.push({
        document,
        contentHash,
        input
      });
    }

    for (let offset = 0; offset < pending.length; offset += MAX_EMBED_BATCH_SIZE) {
      const batch = pending.slice(offset, offset + MAX_EMBED_BATCH_SIZE);
      const vectors = await requestOpenAiEmbeddings({
        texts: batch.map((entry) => entry.input),
        signal: params.signal,
        fetchImpl: params.fetchImpl
      });

      for (const [index, entry] of batch.entries()) {
        const vector = vectors[index];
        embeddings.set(entry.document.documentKey, vector);
        cache.entries[entry.document.documentKey] = {
          model: config.tools.qmdEmbeddingFallbackModel,
          contentHash: entry.contentHash,
          embedding: vector,
          updatedAt: entry.document.updatedAt,
          corpus: entry.document.corpus,
          title: truncate(entry.document.title, 160),
          citation: entry.document.citation,
          excerpt: truncate(entry.document.text, 280)
        };
      }
    }

    if (pending.length > 0) {
      await writeJsonFileAtomic(config.storage.qmdEmbeddingFallbackCacheFile, cache);
    }

    return embeddings;
  });
}

function buildSummary(reason: string, hits: RankedDocument[], maxSnippetChars: number): string {
  const lines = hits.map((hit, index) => {
    const corpusLabel = hit.corpus === 'memory' ? 'MEMORY' : 'RAG';
    return `${index + 1}. [${corpusLabel}] ${truncate(hit.title, 120)} score=${hit.score.toFixed(3)}\nKaynak: ${hit.citation}\n${truncate(hit.text, maxSnippetChars)}`;
  });

  return `QMD local arama kullanılamadı (${truncate(reason, 180)}). OpenAI embedding fallback sonucu:\n\n${lines.join('\n\n')}`;
}

export async function executeQmdEmbeddingFallback(params: {
  input: ToolInput;
  maxResults: number;
  maxSnippetChars: number;
  reason: string;
  fetchImpl?: typeof fetch;
}): Promise<ToolResult | null> {
  if (!config.tools.qmdEmbeddingFallbackEnabled) {
    return null;
  }

  if (!params.input.tenantId) {
    return null;
  }

  if (!config.tools.qmdEmbeddingFallbackOpenAiApiKey?.trim()) {
    return {
      tool: 'qmd_search',
      summary: `QMD local arama kullanılamadı (${truncate(params.reason, 180)}). Embedding fallback hazır değil: OPENAI_API_KEY tanımlı değil.`,
      citations: []
    };
  }

  try {
    throwIfAborted(params.input.signal);
    const documents = await collectRuntimeDocuments(params.input.tenantId);

    if (documents.length === 0) {
      return {
        tool: 'qmd_search',
        summary: `QMD local arama kullanılamadı (${truncate(params.reason, 180)}). Embedding fallback için tenant memory/RAG corpus boş.`,
        citations: []
      };
    }

    const candidates = rankCandidateDocuments(
      params.input.query,
      documents,
      Math.max(1, config.tools.qmdEmbeddingFallbackCandidateLimit)
    );

    const [queryEmbedding] = await requestOpenAiEmbeddings({
      texts: [truncate(params.input.query, config.tools.qmdEmbeddingFallbackMaxInputChars)],
      signal: params.input.signal,
      fetchImpl: params.fetchImpl
    });
    const documentEmbeddings = await resolveDocumentEmbeddings({
      documents: candidates,
      signal: params.input.signal,
      fetchImpl: params.fetchImpl
    });

    const lexicalNormalized = normalizeScores(candidates.map((candidate) => candidate.lexicalScore));
    const ranked = candidates
      .map((candidate, index) => {
        const embedding = documentEmbeddings.get(candidate.documentKey) ?? [];
        const semanticScore = cosineSimilarity(queryEmbedding, embedding);
        const score = semanticScore * 0.82 + lexicalNormalized[index] * 0.18;

        return {
          ...candidate,
          semanticScore,
          score
        } satisfies RankedDocument;
      })
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return right.updatedAt - left.updatedAt;
      });

    const minScore = Math.max(0, config.tools.qmdEmbeddingFallbackMinScore);
    const topHits = ranked.filter((entry, index) => index < params.maxResults && (index === 0 || entry.score >= minScore));

    if (topHits.length === 0) {
      return {
        tool: 'qmd_search',
        summary: `QMD local arama kullanılamadı (${truncate(params.reason, 180)}). OpenAI embedding fallback anlamlı eşleşme bulamadı.`,
        citations: []
      };
    }

    return {
      tool: 'qmd_search',
      summary: buildSummary(params.reason, topHits, params.maxSnippetChars),
      citations: [...new Set(topHits.map((hit) => hit.citation))],
      raw: {
        provider: 'openai-embedding-fallback',
        model: config.tools.qmdEmbeddingFallbackModel,
        reason: params.reason,
        candidateCount: candidates.length,
        totalDocuments: documents.length,
        hits: topHits.map((hit) => ({
          corpus: hit.corpus,
          citation: hit.citation,
          score: hit.score,
          semanticScore: hit.semanticScore,
          lexicalScore: hit.lexicalScore
        }))
      }
    };
  } catch (error) {
    return {
      tool: 'qmd_search',
      summary: `QMD local arama kullanılamadı (${truncate(params.reason, 180)}). OpenAI embedding fallback da başarısız oldu: ${truncate(error instanceof Error ? error.message : String(error), 220)}`,
      citations: []
    };
  }
}

export const __private__ = {
  tokenize,
  truncate,
  cosineSimilarity,
  computeLexicalScore,
  rankCandidateDocuments,
  buildEmbeddingInput,
  buildSummary
};
