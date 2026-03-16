import crypto from 'node:crypto';
import { config } from '../config.js';
import { collectTenantChunks, collectTenantDocuments, readOnlyRagStore, withRagStore } from './store.js';
import type {
  RagChunkRecord,
  RagDocumentInput,
  RagDocumentRecord,
  RagSearchHit,
  RagStorePayload
} from './types.js';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'at', 'is', 'are', 'be', 'with', 'as', 'by', 'from',
  'that', 'this', 'it', 'its', 'into', 'about', 'we', 'you', 'your', 'our', 'their', 'they', 'he', 'she', 'them',
  've', 'de', 'da', 'bir', 'veya', 'ile', 'için', 'olarak', 'bu', 'şu', 'o', 'da', 'de', 'mi', 'mı', 'mu', 'mü',
  'çok', 'az', 'daha', 'en', 'gibi', 'ama', 'fakat', 'ancak', 've', 'ile', 'ya', 'yada', 'ile', 'biz', 'siz', 'ben'
]);

const MAX_DOCUMENT_CHARS = 200_000;
const MAX_INGEST_DOCUMENTS = 20;
const MAX_TOTAL_INGEST_CHARS = 700_000;

function tokenize(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9ğüşöçıİĞÜŞÖÇ]+/gi) ?? [])
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 1)
    .filter((token) => !STOP_WORDS.has(token));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripHtml(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  );
}

function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  const cleaned = normalizeWhitespace(text);
  if (!cleaned) return [];

  const chunks: string[] = [];
  let start = 0;

  while (start < cleaned.length) {
    const end = Math.min(cleaned.length, start + chunkSize);
    const slice = cleaned.slice(start, end);

    // Prefer word-boundary endings when possible.
    const boundary = end < cleaned.length ? Math.max(slice.lastIndexOf('. '), slice.lastIndexOf(' ')) : -1;
    const normalizedSlice = normalizeWhitespace(boundary > chunkSize * 0.55 ? slice.slice(0, boundary + 1) : slice);

    if (normalizedSlice) chunks.push(normalizedSlice);

    if (end >= cleaned.length) break;

    const step = Math.max(40, chunkSize - overlap);
    start += step;
  }

  return chunks;
}

function ensureTenantIsolation(tenantId: string) {
  if (!tenantId.trim()) {
    throw new Error('tenant_id_required');
  }
}

function sanitizeSource(source: string | undefined): string {
  if (!source || !source.trim()) return 'tenant-ingested';
  return source.trim().slice(0, 500);
}

function sanitizeTitle(title: string | undefined, fallback = 'Untitled Document'): string {
  const normalized = (title ?? '').trim();
  return normalized ? normalized.slice(0, 200) : fallback;
}

function computeChunkScore(params: {
  queryTokens: string[];
  idf: Map<string, number>;
  chunk: RagChunkRecord;
  queryRaw: string;
}): number {
  const { queryTokens, idf, chunk, queryRaw } = params;
  if (queryTokens.length === 0 || chunk.tokens.length === 0) return 0;

  const frequency = new Map<string, number>();
  for (const token of chunk.tokens) {
    frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }

  let rawScore = 0;
  const queryUnique = new Set(queryTokens);
  const matched = new Set<string>();

  for (const token of queryTokens) {
    const tf = (frequency.get(token) ?? 0) / chunk.tokens.length;
    if (tf > 0) matched.add(token);
    rawScore += tf * (idf.get(token) ?? 1);
  }

  const coverageBoost = queryUnique.size > 0 ? (matched.size / queryUnique.size) * 0.2 : 0;
  const phraseBoost = chunk.text.toLowerCase().includes(queryRaw.toLowerCase().trim()) ? 0.25 : 0;

  return rawScore + coverageBoost + phraseBoost;
}

function buildIdf(chunks: RagChunkRecord[], queryTokens: string[]): Map<string, number> {
  const idf = new Map<string, number>();
  const n = chunks.length;

  for (const token of new Set(queryTokens)) {
    let df = 0;
    for (const chunk of chunks) {
      if (chunk.tokens.includes(token)) df += 1;
    }

    const value = Math.log((n + 1) / (df + 1)) + 1;
    idf.set(token, value);
  }

  return idf;
}

export async function ingestDocumentsForTenant(params: {
  tenantId: string;
  documents: RagDocumentInput[];
  chunkSize?: number;
  chunkOverlap?: number;
}): Promise<{ documentIds: string[]; ingestedDocuments: number; ingestedChunks: number }> {
  const { tenantId, documents } = params;
  ensureTenantIsolation(tenantId);

  if (documents.length === 0) {
    throw new Error('documents_required');
  }

  if (documents.length > MAX_INGEST_DOCUMENTS) {
    throw new Error(`too_many_documents_max_${MAX_INGEST_DOCUMENTS}`);
  }

  const chunkSize = params.chunkSize ?? config.rag.defaultChunkSize;
  const chunkOverlap = params.chunkOverlap ?? config.rag.defaultChunkOverlap;

  if (chunkOverlap >= chunkSize) {
    throw new Error('chunk_overlap_must_be_lower_than_chunk_size');
  }

  let totalChars = 0;

  const prepared = documents.map((doc, index) => {
    const rawContent = normalizeWhitespace(doc.content);

    if (!rawContent) {
      throw new Error(`document_${index}_content_required`);
    }

    if (rawContent.length > MAX_DOCUMENT_CHARS) {
      throw new Error(`document_${index}_too_large_max_${MAX_DOCUMENT_CHARS}`);
    }

    totalChars += rawContent.length;

    return {
      documentId: doc.documentId?.trim() || `doc_${crypto.randomUUID().replace(/-/g, '')}`,
      title: sanitizeTitle(doc.title, `Document ${index + 1}`),
      source: sanitizeSource(doc.source),
      content: rawContent
    };
  });

  if (totalChars > MAX_TOTAL_INGEST_CHARS) {
    throw new Error(`total_content_too_large_max_${MAX_TOTAL_INGEST_CHARS}`);
  }

  const now = Date.now();

  return withRagStore(async (store) => {
    let ingestedChunks = 0;

    for (const doc of prepared) {
      // Remove previous version for same tenant/documentId to keep replace semantics deterministic.
      const previous = store.documents[doc.documentId];
      if (previous && previous.tenantId === tenantId) {
        for (const chunkId of previous.chunkIds) {
          delete store.chunks[chunkId];
        }
      }

      const chunks = chunkText(doc.content, chunkSize, chunkOverlap);
      if (chunks.length === 0) continue;

      const chunkIds: string[] = [];

      for (const chunkTextValue of chunks) {
        const chunkId = `chk_${crypto.randomUUID().replace(/-/g, '')}`;
        const tokens = tokenize(chunkTextValue);
        if (tokens.length === 0) continue;

        store.chunks[chunkId] = {
          chunkId,
          documentId: doc.documentId,
          tenantId,
          title: doc.title,
          source: doc.source,
          text: chunkTextValue,
          tokens,
          createdAt: now
        };

        chunkIds.push(chunkId);
      }

      if (chunkIds.length === 0) continue;

      store.documents[doc.documentId] = {
        documentId: doc.documentId,
        tenantId,
        title: doc.title,
        source: doc.source,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        chunkIds
      };

      ingestedChunks += chunkIds.length;
    }

    return {
      documentIds: prepared.map((d) => d.documentId),
      ingestedDocuments: prepared.length,
      ingestedChunks
    };
  });
}

export async function ingestUrlForTenant(params: {
  tenantId: string;
  url: string;
  title?: string;
  chunkSize?: number;
  chunkOverlap?: number;
}): Promise<{ documentIds: string[]; ingestedDocuments: number; ingestedChunks: number }> {
  const tenantId = params.tenantId.trim();
  ensureTenantIsolation(tenantId);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(params.url);
  } catch {
    throw new Error('invalid_url');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('invalid_url_protocol');
  }

  const response = await fetch(parsedUrl, {
    signal: AbortSignal.timeout(15_000)
  });

  if (!response.ok) {
    throw new Error(`url_fetch_failed_${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const raw = await response.text();

  const text = /html|xml/i.test(contentType) ? stripHtml(raw) : normalizeWhitespace(raw);
  const title = sanitizeTitle(params.title, parsedUrl.hostname);

  return ingestDocumentsForTenant({
    tenantId,
    documents: [
      {
        title,
        source: parsedUrl.toString(),
        content: text.slice(0, MAX_DOCUMENT_CHARS)
      }
    ],
    chunkSize: params.chunkSize,
    chunkOverlap: params.chunkOverlap
  });
}

export async function searchTenantKnowledge(params: {
  tenantId: string;
  query: string;
  limit?: number;
  minScore?: number;
}): Promise<RagSearchHit[]> {
  const tenantId = params.tenantId.trim();
  ensureTenantIsolation(tenantId);

  const query = normalizeWhitespace(params.query);
  const queryTokens = tokenize(query);

  if (queryTokens.length === 0) return [];

  return readOnlyRagStore(async (store) => {
    const chunks = collectTenantChunks(store, tenantId);
    if (chunks.length === 0) return [];

    const idf = buildIdf(chunks, queryTokens);
    const minScore = params.minScore ?? 0.04;
    const limit = Math.min(Math.max(params.limit ?? 6, 1), 20);

    const scored = chunks
      .map((chunk) => {
        const score = computeChunkScore({
          queryTokens,
          idf,
          chunk,
          queryRaw: query
        });

        return { chunk, score };
      })
      .filter((entry) => entry.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map(({ chunk, score }) => {
      const doc = store.documents[chunk.documentId];
      return {
        documentId: chunk.documentId,
        chunkId: chunk.chunkId,
        title: doc?.title ?? chunk.title,
        source: doc?.source ?? chunk.source,
        content: chunk.text,
        score: Number(score.toFixed(4))
      };
    });
  });
}

export async function listTenantDocuments(params: {
  tenantId: string;
  limit?: number;
}): Promise<RagDocumentRecord[]> {
  const tenantId = params.tenantId.trim();
  ensureTenantIsolation(tenantId);

  return readOnlyRagStore(async (store) => {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    return collectTenantDocuments(store, tenantId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  });
}

export async function deleteTenantDocument(params: {
  tenantId: string;
  documentId: string;
}): Promise<{ removed: boolean }> {
  const tenantId = params.tenantId.trim();
  const documentId = params.documentId.trim();
  ensureTenantIsolation(tenantId);

  if (!documentId) return { removed: false };

  return withRagStore(async (store) => {
    const doc = store.documents[documentId];
    if (!doc || doc.tenantId !== tenantId) {
      return { removed: false };
    }

    for (const chunkId of doc.chunkIds) {
      delete store.chunks[chunkId];
    }

    delete store.documents[documentId];
    return { removed: true };
  });
}

export async function getTenantKnowledgeStats(tenantId: string): Promise<{ documents: number; chunks: number }> {
  const id = tenantId.trim();
  ensureTenantIsolation(id);

  return readOnlyRagStore(async (store: RagStorePayload) => {
    const docs = collectTenantDocuments(store, id);
    const chunks = collectTenantChunks(store, id);
    return {
      documents: docs.length,
      chunks: chunks.length
    };
  });
}
