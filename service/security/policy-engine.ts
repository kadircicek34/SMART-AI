export type ToolName = 'web_search' | 'wikipedia' | 'deep_research' | 'financial_deep_search' | 'rag_search';

export type PolicyContext = {
  tenantId: string;
  requestedTools: ToolName[];
};

export type PolicyDecision = {
  allowed: ToolName[];
  denied: ToolName[];
  maxSteps: number;
  maxToolCalls: number;
};

const DEFAULT_ALLOWED_TOOLS: ToolName[] = ['web_search', 'wikipedia', 'deep_research', 'financial_deep_search', 'rag_search'];

function tenantSpecificTools(tenantId: string): ToolName[] | null {
  const raw = process.env.TENANT_TOOL_POLICIES_JSON;
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Record<string, ToolName[]>;
    return parsed[tenantId] ?? null;
  } catch {
    return null;
  }
}

export function enforceToolPolicy(ctx: PolicyContext): PolicyDecision {
  const allowSource = tenantSpecificTools(ctx.tenantId) ?? DEFAULT_ALLOWED_TOOLS;
  const allowSet = new Set<ToolName>(allowSource);

  const allowed = ctx.requestedTools.filter((t) => allowSet.has(t));
  const denied = ctx.requestedTools.filter((t) => !allowSet.has(t));

  return {
    allowed,
    denied,
    maxSteps: Number(process.env.MAX_STEPS ?? 6),
    maxToolCalls: Number(process.env.MAX_TOOL_CALLS ?? 6)
  };
}
