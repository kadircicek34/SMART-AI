import { searchTenantKnowledge } from '../rag/service.js';
import type { ToolAdapter, ToolInput, ToolResult } from './types.js';

function formatChunk(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= 260) return trimmed;
  return `${trimmed.slice(0, 257)}...`;
}

export const ragSearchTool: ToolAdapter = {
  name: 'rag_search',
  async execute(input: ToolInput): Promise<ToolResult> {
    if (!input.tenantId) {
      throw new Error('rag_search_requires_tenant');
    }

    const hits = await searchTenantKnowledge({
      tenantId: input.tenantId,
      query: input.query,
      limit: 6,
      minScore: 0.03
    });

    if (hits.length === 0) {
      return {
        tool: 'rag_search',
        summary: 'Tenant bilgi tabanında sorguyla eşleşen içerik bulunamadı.',
        citations: []
      };
    }

    const lines = hits.map(
      (hit, index) =>
        `${index + 1}. [${hit.title}] score=${hit.score.toFixed(3)}\n${formatChunk(hit.content)}`
    );

    const citations = hits.map((hit) => `${hit.source}#${hit.chunkId}`);

    return {
      tool: 'rag_search',
      summary: lines.join('\n\n'),
      citations,
      raw: {
        hits
      }
    };
  }
};
