export type ToolName =
  | 'web_search'
  | 'wikipedia'
  | 'deep_research'
  | 'financial_deep_search'
  | 'openbb_search'
  | 'rag_search'
  | 'memory_search'
  | 'qmd_search'
  | 'mevzuat_mcp_search'
  | 'borsa_mcp_search'
  | 'yargi_mcp_search';

export type ToolInput = {
  query: string;
  locale?: string;
  tenantId?: string;
};

export type ToolResult = {
  tool: ToolName;
  summary: string;
  citations: string[];
  raw?: unknown;
};

export interface ToolAdapter {
  name: ToolName;
  execute(input: ToolInput): Promise<ToolResult>;
}
