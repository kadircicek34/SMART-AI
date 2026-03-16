import { createBudget, assertWithinRuntime } from '../security/budget-guard.js';
import { enforceToolPolicy } from '../security/policy-engine.js';
import type { ToolName, ToolResult } from '../tools/types.js';
import { executePlan } from './executor.js';
import { chooseBestPlan } from './thinking-loop.js';
import { synthesizeAnswer } from './synthesizer.js';
import type { Plan, RunInput, RunOutput } from './types.js';
import { verifyEvidence } from './verifier.js';

function normalizePlanTools(plan: Plan, allowed: ToolName[]): Plan {
  return {
    ...plan,
    tools: plan.tools.filter((t) => allowed.includes(t))
  };
}

function addSuggestedTool(plan: Plan, suggestedTool: ToolName): Plan {
  if (plan.tools.includes(suggestedTool)) return plan;
  return {
    ...plan,
    tools: [...plan.tools, suggestedTool]
  };
}

export async function runOrchestrator(input: RunInput): Promise<RunOutput> {
  const startedAt = Date.now();
  const budget = createBudget();
  const lastUser = [...input.messages].reverse().find((m) => m.role === 'user');
  const query = lastUser?.content?.trim() || 'No query provided.';

  const isSmallTalk = /^(selam|merhaba|hi|hello|hey|nasılsın|naber)[!.?\s]*$/i.test(query);
  if (isSmallTalk) {
    return {
      text: 'Merhaba Başkanım, nasıl yardımcı olayım?',
      finishReason: 'stop',
      model: 'rule-based-smalltalk',
      usage: {
        promptTokens: Math.ceil(JSON.stringify(input.messages).length / 4),
        completionTokens: 10,
        totalTokens: Math.ceil(JSON.stringify(input.messages).length / 4) + 10
      },
      toolResults: [],
      plan: {
        objective: query,
        tools: [],
        reasoning: 'Smalltalk short-circuit'
      }
    };
  }

  let plan = chooseBestPlan(query);

  const policy = enforceToolPolicy({
    tenantId: input.tenantId,
    requestedTools: plan.tools
  });

  plan = normalizePlanTools(plan, policy.allowed);

  let allResults: ToolResult[] = [];
  let verification = verifyEvidence(plan, allResults, query);

  const stepLimit = Math.max(1, Math.min(policy.maxSteps, 4));
  let step = 0;

  while (step < stepLimit) {
    const toolsToRun: ToolName[] =
      step === 0
        ? [...plan.tools]
        : verification.suggestedTool && !allResults.some((r) => r.tool === verification.suggestedTool)
          ? [verification.suggestedTool]
          : [];

    if (toolsToRun.length === 0) break;

    assertWithinRuntime(startedAt, budget);

    const passResults = await executePlan({
      plan: { ...plan, tools: toolsToRun },
      query,
      maxToolCalls: Math.min(policy.maxToolCalls, budget.maxToolCalls, toolsToRun.length),
      tenantId: input.tenantId
    });

    allResults = [...allResults, ...passResults];

    if (verification.suggestedTool) {
      plan = addSuggestedTool(plan, verification.suggestedTool);
    }

    verification = verifyEvidence(plan, allResults, query);
    if (verification.sufficient || !verification.suggestedTool) {
      break;
    }

    step += 1;
  }

  const synthesized = await synthesizeAnswer({
    query,
    model: input.model,
    openRouterApiKey: input.openRouterApiKey,
    plan,
    verification,
    results: allResults
  });

  const promptTokensApprox = Math.ceil(JSON.stringify(input.messages).length / 4);

  return {
    text: synthesized.text,
    finishReason: 'stop',
    model: synthesized.model,
    usage: {
      promptTokens: synthesized.usage.promptTokens || promptTokensApprox,
      completionTokens: synthesized.usage.completionTokens,
      totalTokens: synthesized.usage.totalTokens || promptTokensApprox + synthesized.usage.completionTokens
    },
    toolResults: allResults,
    plan
  };
}
