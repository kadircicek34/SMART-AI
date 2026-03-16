export type Budget = {
  maxSteps: number;
  maxToolCalls: number;
  maxRuntimeMs: number;
};

export function createBudget(partial?: Partial<Budget>): Budget {
  return {
    maxSteps: partial?.maxSteps ?? Number(process.env.MAX_STEPS ?? 6),
    maxToolCalls: partial?.maxToolCalls ?? Number(process.env.MAX_TOOL_CALLS ?? 6),
    maxRuntimeMs: partial?.maxRuntimeMs ?? Number(process.env.MAX_RUNTIME_MS ?? 60_000)
  };
}

export function assertWithinRuntime(startedAtMs: number, budget: Budget) {
  if (Date.now() - startedAtMs > budget.maxRuntimeMs) {
    throw new Error('Runtime budget exceeded.');
  }
}
