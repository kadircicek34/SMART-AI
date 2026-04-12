import { config } from '../config.js';
import { createBudget, assertWithinRuntime } from '../security/budget-guard.js';
import { enforceToolPolicy } from '../security/policy-engine.js';
import type { ToolName, ToolResult } from '../tools/types.js';
import { executePlan } from './executor.js';
import { buildPlanningQuery, classifyPromptProfile, generateDirectAnswer, userAskedForBrevity } from './direct-answer.js';
import { chooseBestPlan } from './thinking-loop.js';
import { synthesizeAnswer } from './synthesizer.js';
import type { Plan, RunInput, RunOutput } from './types.js';
import { scoreAnswerSimplicity, verifyEvidence, type VerificationResult } from './verifier.js';
import { throwIfAborted } from '../utils/abort.js';

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

function toolPassSignature(toolNames: ToolName[]): string {
  return [...toolNames].sort().join('|');
}

function updateStageStatuses(plan: Plan, completedTools: ToolName[]): Plan {
  const completed = new Set(completedTools);
  const stages = plan.stages ?? [{ id: 'direct', title: 'Doğrudan yanıt', tools: [], status: 'pending' as const }];
  return {
    ...plan,
    stages: stages.map((stage) => {
      if (stage.tools.length === 0) {
        return { ...stage, status: completedTools.length === 0 ? 'running' : 'done' };
      }
      const doneCount = stage.tools.filter((tool) => completed.has(tool)).length;
      const status = doneCount === stage.tools.length ? 'done' : doneCount > 0 ? 'running' : 'pending';
      return { ...stage, status };
    })
  };
}

function looksFailureSummary(summary: string | undefined): boolean {
  if (!summary) return true;
  return /\b(failed?|error|timeout|denied|unavailable|no data|not found|empty result)\b/i.test(summary);
}

function mergeUsage(
  ...parts: Array<
    | {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      }
    | undefined
  >
): { promptTokens: number; completionTokens: number; totalTokens: number } {
  const merged = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
  };

  for (const part of parts) {
    if (!part) {
      continue;
    }

    merged.promptTokens += part.promptTokens;
    merged.completionTokens += part.completionTokens;
    merged.totalTokens += part.totalTokens;
  }

  return merged;
}

function countWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function shouldUseDirectModelResponse(params: { openRouterApiKey?: string; plan: Plan }): boolean {
  return Boolean(params.openRouterApiKey) && params.plan.tools.length === 0;
}

function shouldPreferDraftAnswer(params: {
  query: string;
  draftAnswer?: string;
  synthesizedAnswer: string;
  verification: VerificationResult;
  toolResults: ToolResult[];
  allowNoToolSecondPass?: boolean;
}): boolean {
  if (!params.draftAnswer?.trim()) {
    return false;
  }

  if (!params.synthesizedAnswer.trim()) {
    return true;
  }

  if (params.toolResults.length === 0) {
    if (!params.allowNoToolSecondPass) {
      return true;
    }

    const draftWords = countWords(params.draftAnswer);
    const synthesizedWords = countWords(params.synthesizedAnswer);
    return draftWords >= 70 && synthesizedWords < Math.floor(draftWords * 0.6);
  }

  if (!params.verification.sufficient && params.toolResults.every((result) => looksFailureSummary(result.summary))) {
    return true;
  }

  if (!params.verification.sufficient && !userAskedForBrevity(params.query)) {
    const draftWords = countWords(params.draftAnswer);
    const synthesizedWords = countWords(params.synthesizedAnswer);
    if (draftWords >= 70 && synthesizedWords < Math.floor(draftWords * 0.5)) {
      return true;
    }
  }

  return false;
}

function promptTokensApprox(messages: RunInput['messages']): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

function decoratePlanReasoning(plan: Plan, mode: string): Plan {
  return {
    ...plan,
    reasoning: `${plan.reasoning} | ${mode}`
  };
}

export async function runOrchestrator(input: RunInput): Promise<RunOutput> {
  throwIfAborted(input.signal);

  const startedAt = Date.now();
  const budget = createBudget();
  const lastUser = [...input.messages].reverse().find((m) => m.role === 'user');
  const rawQuery = lastUser?.content?.trim() || 'No query provided.';
  const planningQuery = buildPlanningQuery(input.messages);

  const isSmallTalk = /^(selam|merhaba|hi|hello|hey|nasılsın|naber)[!.?\s]*$/i.test(rawQuery);
  if (isSmallTalk) {
    const smallTalkText = 'Merhaba Başkanım, nasıl yardımcı olayım?';
    const simplicity = scoreAnswerSimplicity(smallTalkText);
    const simplicityThreshold = config.verifier.minSimplicityScore;

    return {
      text: smallTalkText,
      finishReason: 'stop',
      model: 'rule-based-smalltalk',
      usage: {
        promptTokens: promptTokensApprox(input.messages),
        completionTokens: 10,
        totalTokens: promptTokensApprox(input.messages) + 10
      },
      toolResults: [],
      plan: {
        objective: rawQuery,
        tools: [],
        reasoning: 'Smalltalk short-circuit',
        stages: [{ id: 'direct', title: 'Doğrudan yanıt', tools: [], status: 'done' }]
      },
      verification: {
        evidence: {
          sufficient: true,
          confidence: 1,
          reason: 'Smalltalk short-circuit',
          suggestedTool: undefined
        },
        simplicity: {
          ...simplicity,
          threshold: simplicityThreshold,
          belowThreshold: simplicity.score < simplicityThreshold
        }
      }
    };
  }

  let plan = chooseBestPlan(planningQuery);

  const policy = enforceToolPolicy({
    tenantId: input.tenantId,
    requestedTools: plan.tools
  });

  plan = normalizePlanTools(plan, policy.allowed);

  const promptProfile = classifyPromptProfile({
    query: rawQuery,
    planningQuery,
    messages: input.messages,
    toolCount: plan.tools.length
  });

  plan = decoratePlanReasoning(
    plan,
    promptProfile.useTwoPass ? 'expert-persona + enriched-query + two-pass' : 'expert-persona + reasoning-enabled'
  );

  if (shouldUseDirectModelResponse({ openRouterApiKey: input.openRouterApiKey, plan })) {
    try {
      const direct = await generateDirectAnswer({
        apiKey: input.openRouterApiKey!,
        model: input.model,
        messages: input.messages,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        signal: input.signal,
        promptProfile,
        phase: promptProfile.useTwoPass ? 'analysis-pass' : 'single-pass'
      });

      if (!promptProfile.useTwoPass) {
        const simplicity = scoreAnswerSimplicity(direct.text);
        const simplicityThreshold = config.verifier.minSimplicityScore;

        return {
          text: direct.text,
          finishReason: 'stop',
          model: direct.model,
          usage: direct.usage,
          toolResults: [],
          plan,
          verification: {
            evidence: {
              sufficient: true,
              confidence: 0.9,
              reason: 'Direct model passthrough selected because no external evidence was required.',
              suggestedTool: undefined
            },
            simplicity: {
              ...simplicity,
              threshold: simplicityThreshold,
              belowThreshold: simplicity.score < simplicityThreshold
            }
          }
        };
      }

      const refinementVerification: VerificationResult = {
        sufficient: true,
        confidence: 0.88,
        reason: 'Complex direct prompt routed through two-pass refinement without external tools.'
      };

      const refined = await synthesizeAnswer({
        query: rawQuery,
        model: input.model,
        openRouterApiKey: input.openRouterApiKey,
        plan,
        verification: refinementVerification,
        results: [],
        messages: input.messages,
        draftAnswer: direct.text,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        signal: input.signal,
        promptProfile
      });

      const finalText = shouldPreferDraftAnswer({
        query: rawQuery,
        draftAnswer: direct.text,
        synthesizedAnswer: refined.text,
        verification: refinementVerification,
        toolResults: [],
        allowNoToolSecondPass: true
      })
        ? direct.text
        : refined.text;

      const finalModel = finalText === direct.text ? direct.model : refined.model;
      const mergedUsage = mergeUsage(direct.usage, refined.usage);
      const approx = promptTokensApprox(input.messages);
      const simplicity = scoreAnswerSimplicity(finalText);
      const simplicityThreshold = config.verifier.minSimplicityScore;

      return {
        text: finalText,
        finishReason: 'stop',
        model: finalModel,
        usage: {
          promptTokens: mergedUsage.promptTokens || approx,
          completionTokens: mergedUsage.completionTokens,
          totalTokens: mergedUsage.totalTokens || approx + mergedUsage.completionTokens
        },
        toolResults: [],
        plan,
        verification: {
          evidence: {
            sufficient: true,
            confidence: 0.9,
            reason: 'Complex prompt completed with two-pass direct generation and expert persona prompting.',
            suggestedTool: undefined
          },
          simplicity: {
            ...simplicity,
            threshold: simplicityThreshold,
            belowThreshold: simplicity.score < simplicityThreshold
          }
        }
      };
    } catch {
      // fall through to orchestrated path
    }
  }

  let draftResponse:
    | {
        text: string;
        usage: { promptTokens: number; completionTokens: number; totalTokens: number };
        model: string;
      }
    | undefined;

  if (input.openRouterApiKey) {
    try {
      assertWithinRuntime(startedAt, budget);
      draftResponse = await generateDirectAnswer({
        apiKey: input.openRouterApiKey,
        model: input.model,
        messages: input.messages,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        signal: input.signal,
        promptProfile,
        phase: promptProfile.useTwoPass ? 'analysis-pass' : 'single-pass'
      });
    } catch {
      draftResponse = undefined;
    }
  }

  let allResults: ToolResult[] = [];
  plan = updateStageStatuses(plan, []);
  let verification = verifyEvidence(plan, allResults, planningQuery);

  const stepLimit = Math.max(1, Math.min(policy.maxSteps, config.orchestrator.maxToolPasses));
  const passSignatureCounts = new Map<string, number>();

  let step = 0;

  while (step < stepLimit) {
    const toolsToRun: ToolName[] =
      step === 0
        ? [...plan.tools]
        : verification.suggestedTool && !allResults.some((r) => r.tool === verification.suggestedTool)
          ? [verification.suggestedTool]
          : [];

    if (toolsToRun.length === 0) break;

    const signature = toolPassSignature(toolsToRun);
    const signatureCount = (passSignatureCounts.get(signature) ?? 0) + 1;
    passSignatureCounts.set(signature, signatureCount);

    if (signatureCount > config.orchestrator.maxRepeatedToolPasses) {
      break;
    }

    assertWithinRuntime(startedAt, budget);
    throwIfAborted(input.signal);

    const passResults = await executePlan({
      plan: { ...plan, tools: toolsToRun },
      query: planningQuery,
      maxToolCalls: Math.min(policy.maxToolCalls, budget.maxToolCalls, toolsToRun.length),
      tenantId: input.tenantId,
      signal: input.signal
    });

    allResults = [...allResults, ...passResults];
    plan = updateStageStatuses(
      plan,
      allResults.map((result) => result.tool)
    );

    if (verification.suggestedTool) {
      plan = addSuggestedTool(plan, verification.suggestedTool);
    }

    verification = verifyEvidence(plan, allResults, planningQuery);
    if (verification.sufficient || !verification.suggestedTool) {
      break;
    }

    step += 1;
  }

  throwIfAborted(input.signal);

  const synthesized = await synthesizeAnswer({
    query: rawQuery,
    model: input.model,
    openRouterApiKey: input.openRouterApiKey,
    plan,
    verification,
    results: allResults,
    messages: input.messages,
    draftAnswer: draftResponse?.text,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    signal: input.signal,
    promptProfile
  });

  const finalText = shouldPreferDraftAnswer({
    query: rawQuery,
    draftAnswer: draftResponse?.text,
    synthesizedAnswer: synthesized.text,
    verification,
    toolResults: allResults,
    allowNoToolSecondPass: promptProfile.useTwoPass
  })
    ? draftResponse!.text
    : synthesized.text;

  const finalModel = finalText === draftResponse?.text ? draftResponse.model : synthesized.model;
  const mergedUsage = mergeUsage(draftResponse?.usage, synthesized.usage);
  const approx = promptTokensApprox(input.messages);

  const simplicity = scoreAnswerSimplicity(finalText);
  const simplicityThreshold = config.verifier.minSimplicityScore;

  return {
    text: finalText,
    finishReason: 'stop',
    model: finalModel,
    usage: {
      promptTokens: mergedUsage.promptTokens || approx,
      completionTokens: mergedUsage.completionTokens,
      totalTokens: mergedUsage.totalTokens || approx + mergedUsage.completionTokens
    },
    toolResults: allResults,
    plan,
    verification: {
      evidence: {
        sufficient: verification.sufficient,
        confidence: verification.confidence,
        reason: verification.reason,
        suggestedTool: verification.suggestedTool
      },
      simplicity: {
        ...simplicity,
        threshold: simplicityThreshold,
        belowThreshold: simplicity.score < simplicityThreshold
      }
    }
  };
}

export const __private__ = {
  toolPassSignature,
  shouldPreferDraftAnswer,
  shouldUseDirectModelResponse,
  decoratePlanReasoning
};
