import { runTools } from '../tools/router.js';
import type { ToolResult } from '../tools/types.js';
import type { Plan } from './types.js';

export async function executePlan(params: {
  plan: Plan;
  query: string;
  maxToolCalls: number;
  tenantId: string;
  signal?: AbortSignal;
}): Promise<ToolResult[]> {
  return runTools({
    toolNames: params.plan.tools,
    query: params.query,
    maxCalls: params.maxToolCalls,
    tenantId: params.tenantId,
    signal: params.signal
  });
}
