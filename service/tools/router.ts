import { deepResearchTool } from './deep-research.js';
import { financialDeepSearchTool } from './financial.js';
import { webSearchTool } from './web-search.js';
import { wikipediaTool } from './wikipedia.js';
import { ragSearchTool } from './rag-search.js';
import { memorySearchTool } from './memory-search.js';
import type { ToolAdapter, ToolName, ToolResult } from './types.js';

const tools: Record<ToolName, ToolAdapter> = {
  web_search: webSearchTool,
  wikipedia: wikipediaTool,
  deep_research: deepResearchTool,
  financial_deep_search: financialDeepSearchTool,
  rag_search: ragSearchTool,
  memory_search: memorySearchTool
};

export function getTool(name: ToolName): ToolAdapter {
  return tools[name];
}

export async function runTools(params: {
  toolNames: ToolName[];
  query: string;
  maxCalls: number;
  tenantId: string;
}): Promise<ToolResult[]> {
  const selected = params.toolNames.slice(0, params.maxCalls);
  const results: ToolResult[] = [];

  for (const toolName of selected) {
    const adapter = tools[toolName];
    try {
      const result = await adapter.execute({ query: params.query, tenantId: params.tenantId });
      results.push(result);
    } catch (error) {
      results.push({
        tool: toolName,
        summary: `${toolName} failed: ${error instanceof Error ? error.message : String(error)}`,
        citations: []
      });
    }
  }

  return results;
}
