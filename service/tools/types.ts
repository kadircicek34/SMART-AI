export type ToolName = 'web_search' | 'wikipedia' | 'deep_research' | 'financial_deep_search';

export type ToolInput = {
  query: string;
  locale?: string;
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
