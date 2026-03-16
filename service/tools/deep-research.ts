import { config } from '../config.js';
import type { ToolAdapter, ToolInput, ToolResult } from './types.js';
import { ragSearchTool } from './rag-search.js';
import { memorySearchTool } from './memory-search.js';
import { webSearchTool } from './web-search.js';
import { wikipediaTool } from './wikipedia.js';

type ResearchDependencies = {
  webSearch: Pick<ToolAdapter, 'execute'>;
  wikipedia: Pick<ToolAdapter, 'execute'>;
  ragSearch: Pick<ToolAdapter, 'execute'>;
  memorySearch: Pick<ToolAdapter, 'execute'>;
};

type ResearchLimits = {
  maxQueries: number;
  maxConcurrentUnits: number;
};

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function buildResearchQueryPlan(query: string, maxQueries = config.research.maxQueries): {
  queries: string[];
  overflowCount: number;
} {
  const trimmed = query.trim();
  const candidates = [trimmed];

  if (!/latest|recent|güncel|son/i.test(trimmed)) {
    candidates.push(`${trimmed} latest developments`);
  }

  if (!/compare|karşılaştır|difference|fark|tradeoff/i.test(trimmed)) {
    candidates.push(`${trimmed} key differences and tradeoffs`);
  }

  if (!/risk|risks|challenge|challenges|riskler|zorluklar/i.test(trimmed)) {
    candidates.push(`${trimmed} key risks and challenges`);
  }

  if (!/how|nasıl|implementation|uygulama/i.test(trimmed)) {
    candidates.push(`${trimmed} implementation playbook`);
  }

  const unique = dedupe(candidates);
  const safeMax = Math.max(1, Math.min(maxQueries, 8));
  const queries = unique.slice(0, safeMax);

  return {
    queries,
    overflowCount: Math.max(0, unique.length - queries.length)
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: safeConcurrency }, () => runWorker()));
  return results;
}

async function executeDeepResearch(
  input: ToolInput,
  deps: ResearchDependencies,
  limits: ResearchLimits
): Promise<ToolResult> {
  const { queries: researchQueries, overflowCount } = buildResearchQueryPlan(input.query, limits.maxQueries);
  const notes: string[] = [];
  const citations: string[] = [];

  if (input.tenantId) {
    try {
      const memory = await deps.memorySearch.execute({ query: input.query, tenantId: input.tenantId });
      notes.push('Tenant Memory:');
      notes.push(memory.summary);
      citations.push(...memory.citations);
    } catch (error) {
      notes.push(`Tenant Memory: hata (${toErrorMessage(error)})`);
    }

    try {
      const rag = await deps.ragSearch.execute({ query: input.query, tenantId: input.tenantId });
      notes.push('Tenant RAG:');
      notes.push(rag.summary);
      citations.push(...rag.citations);
    } catch (error) {
      notes.push(`Tenant RAG: hata (${toErrorMessage(error)})`);
    }
  }

  const perQueryNotes = await mapWithConcurrency(
    researchQueries,
    limits.maxConcurrentUnits,
    async (researchQuery) => {
      const [web, wiki] = await Promise.allSettled([
        deps.webSearch.execute({ query: researchQuery }),
        deps.wikipedia.execute({ query: researchQuery })
      ]);

      const section: string[] = [`Sorgu: ${researchQuery}`];
      const sectionCitations: string[] = [];

      if (web.status === 'fulfilled') {
        section.push(`Web:\n${web.value.summary}`);
        sectionCitations.push(...web.value.citations);
      } else {
        section.push(`Web: hata (${toErrorMessage(web.reason)})`);
      }

      if (wiki.status === 'fulfilled') {
        section.push(`Wikipedia:\n${wiki.value.summary}`);
        sectionCitations.push(...wiki.value.citations);
      } else {
        section.push(`Wikipedia: hata (${toErrorMessage(wiki.reason)})`);
      }

      return {
        section,
        sectionCitations
      };
    }
  );

  for (const entry of perQueryNotes) {
    notes.push(entry.section.join('\n'));
    citations.push(...entry.sectionCitations);
  }

  if (overflowCount > 0) {
    notes.push(`Not: Query bütçesi nedeniyle ${overflowCount} ek araştırma varyantı atlandı.`);
  }

  return {
    tool: 'deep_research',
    summary: notes.join('\n\n'),
    citations: dedupe(citations).slice(0, 30),
    raw: {
      researchQueries,
      overflowCount,
      maxConcurrentUnits: Math.max(1, limits.maxConcurrentUnits)
    }
  };
}

export const deepResearchTool: ToolAdapter = {
  name: 'deep_research',
  async execute(input: ToolInput): Promise<ToolResult> {
    return executeDeepResearch(
      input,
      {
        webSearch: webSearchTool,
        wikipedia: wikipediaTool,
        ragSearch: ragSearchTool,
        memorySearch: memorySearchTool
      },
      {
        maxQueries: config.research.maxQueries,
        maxConcurrentUnits: config.research.maxConcurrentUnits
      }
    );
  }
};

export const __private__ = {
  buildResearchQueryPlan,
  mapWithConcurrency,
  executeDeepResearch,
  toErrorMessage
};
