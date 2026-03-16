import { createBudget, assertWithinRuntime } from '../security/budget-guard.js';
import { enforceToolPolicy } from '../security/policy-engine.js';
import type { ToolName } from '../tools/types.js';
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

  assertWithinRuntime(startedAt, budget);

  const firstPassResults = await executePlan({
    plan,
    query,
    maxToolCalls: Math.min(policy.maxToolCalls, budget.maxToolCalls)
  });

  let allResults = [...firstPassResults];
  let verification = verifyEvidence(plan, allResults);

  if (!verification.sufficient && verification.suggestedTool) {
    assertWithinRuntime(startedAt, budget);

    if (!plan.tools.includes(verification.suggestedTool)) {
      plan = {
        ...plan,
        tools: [...plan.tools, verification.suggestedTool]
      };
      const secondPassResults = await executePlan({
        plan: { ...plan, tools: [verification.suggestedTool] },
        query,
        maxToolCalls: 1
      });
      allResults = [...allResults, ...secondPassResults];
      verification = verifyEvidence(plan, allResults);
    }
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
