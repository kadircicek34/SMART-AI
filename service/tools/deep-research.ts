import type { ToolAdapter, ToolInput, ToolResult } from './types.js';
import { ragSearchTool } from './rag-search.js';
import { webSearchTool } from './web-search.js';
import { wikipediaTool } from './wikipedia.js';

function buildResearchQueries(query: string): string[] {
  const trimmed = query.trim();
  const out = [trimmed];

  if (!/latest|recent|güncel|son/i.test(trimmed)) {
    out.push(`${trimmed} latest developments`);
  }

  if (!/compare|karşılaştır|difference|fark/i.test(trimmed)) {
    out.push(`${trimmed} key differences and tradeoffs`);
  }

  return out.slice(0, 3);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export const deepResearchTool: ToolAdapter = {
  name: 'deep_research',
  async execute(input: ToolInput): Promise<ToolResult> {
    const researchQueries = buildResearchQueries(input.query);
    const notes: string[] = [];
    const citations: string[] = [];

    if (input.tenantId) {
      try {
        const rag = await ragSearchTool.execute({ query: input.query, tenantId: input.tenantId });
        notes.push('Tenant RAG:');
        notes.push(rag.summary);
        citations.push(...rag.citations);
      } catch {
        // optional path, continue with public sources
      }
    }

    for (const q of researchQueries) {
      const [web, wiki] = await Promise.all([webSearchTool.execute({ query: q }), wikipediaTool.execute({ query: q })]);

      notes.push(`Sorgu: ${q}`);
      notes.push(`Web:\n${web.summary}`);
      notes.push(`Wikipedia:\n${wiki.summary}`);

      citations.push(...web.citations, ...wiki.citations);
    }

    return {
      tool: 'deep_research',
      summary: notes.join('\n\n'),
      citations: dedupe(citations).slice(0, 24),
      raw: { researchQueries }
    };
  }
};
