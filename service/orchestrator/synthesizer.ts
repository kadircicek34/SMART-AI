import { config } from '../config.js';
import { chatWithOpenRouter } from '../llm/openrouter-client.js';
import type { ToolResult } from '../tools/types.js';
import type { Plan } from './types.js';
import type { VerificationResult } from './verifier.js';

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function buildEvidenceBlock(results: ToolResult[]): string {
  return results
    .map((result) => {
      const cites = result.citations.length > 0 ? result.citations.join(', ') : 'none';
      return `Tool: ${result.tool}\nSummary:\n${result.summary}\nCitations: ${cites}`;
    })
    .join('\n\n---\n\n');
}

function fallbackSynthesis(params: {
  query: string;
  plan: Plan;
  verification: VerificationResult;
  results: ToolResult[];
}): string {
  const citations = dedupe(params.results.flatMap((r) => r.citations));
  const body = params.results.map((r) => `### ${r.tool}\n${r.summary}`).join('\n\n');

  return [
    `Sorgu: ${params.query}`,
    `Plan: ${params.plan.tools.join(', ')}`,
    `Verifier: ${params.verification.reason}`,
    '',
    body,
    '',
    citations.length > 0 ? `Kaynaklar:\n${citations.map((c) => `- ${c}`).join('\n')}` : 'Kaynak bulunamadı.'
  ].join('\n');
}

export async function synthesizeAnswer(params: {
  query: string;
  model: string;
  openRouterApiKey?: string;
  plan: Plan;
  verification: VerificationResult;
  results: ToolResult[];
}): Promise<{ text: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number }; model: string }> {
  const evidence = buildEvidenceBlock(params.results);

  if (!params.openRouterApiKey) {
    return {
      text: fallbackSynthesis(params),
      model: 'local-fallback',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    };
  }

  try {
    const completion = await chatWithOpenRouter({
      apiKey: params.openRouterApiKey,
      model: params.model || config.openRouter.defaultModel,
      messages: [
        {
          role: 'system',
          content:
            'You are an agentic synthesis model. Use provided evidence only. Be concise, factual, and include a Sources list at the end.'
        },
        {
          role: 'user',
          content: [
            `User Query: ${params.query}`,
            `Plan: ${params.plan.tools.join(', ')}`,
            `Verifier: ${params.verification.reason}`,
            '',
            'Evidence:',
            evidence,
            '',
            'Write final answer in Turkish unless query explicitly asks another language.'
          ].join('\n')
        }
      ]
    });

    const citations = dedupe(params.results.flatMap((r) => r.citations));
    const withSources = citations.length
      ? `${completion.text.trim()}\n\nSources:\n${citations.map((c) => `- ${c}`).join('\n')}`
      : completion.text.trim();

    return {
      text: withSources,
      model: completion.model,
      usage: completion.usage
    };
  } catch (error) {
    const fallback = fallbackSynthesis(params);
    return {
      text: `${fallback}\n\n[LLM synthesis fallback reason: ${error instanceof Error ? error.message : String(error)}]`,
      model: 'local-fallback',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    };
  }
}
