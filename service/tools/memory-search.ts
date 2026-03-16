import { searchTenantMemories } from '../memory/service.js';
import type { ToolAdapter, ToolInput, ToolResult } from './types.js';

function formatContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= 220) return trimmed;
  return `${trimmed.slice(0, 217)}...`;
}

export const memorySearchTool: ToolAdapter = {
  name: 'memory_search',
  async execute(input: ToolInput): Promise<ToolResult> {
    if (!input.tenantId) {
      throw new Error('memory_search_requires_tenant');
    }

    const result = await searchTenantMemories({
      tenantId: input.tenantId,
      query: input.query,
      limit: 6,
      minScore: 0.04
    });

    if (result.decision.decision === 'NO_RETRIEVE') {
      return {
        tool: 'memory_search',
        summary: `Memory retrieval gereksiz görüldü (${result.decision.reason}).`,
        citations: [],
        raw: {
          decision: result.decision
        }
      };
    }

    if (result.hits.length === 0) {
      return {
        tool: 'memory_search',
        summary: 'Tenant memory katmanında sorguyla eşleşen kayıt bulunamadı.',
        citations: [],
        raw: {
          decision: result.decision
        }
      };
    }

    const lines = result.hits.map(
      (hit, index) =>
        `${index + 1}. [${hit.category}] score=${hit.score.toFixed(3)}\n${formatContent(hit.content)}`
    );

    const citations = result.hits.map((hit) => `memory://${input.tenantId}/${hit.memoryId}`);

    return {
      tool: 'memory_search',
      summary: lines.join('\n\n'),
      citations,
      raw: {
        decision: result.decision,
        hits: result.hits
      }
    };
  }
};
