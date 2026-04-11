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

function userExplicitlyAskedForSources(query: string): boolean {
  return /(kaynak|sources?|link|referans|citation|alıntı)/i.test(query);
}

function shouldAttachSources(params: {
  query: string;
  verification: VerificationResult;
  hasCitations: boolean;
}): boolean {
  if (!params.hasCitations) return false;

  if (config.synthesizer.citationMode === 'always') return true;
  if (config.synthesizer.citationMode === 'never') return false;

  if (userExplicitlyAskedForSources(params.query)) {
    return true;
  }

  if (config.synthesizer.forceSourcesWhenVerificationLow && !params.verification.sufficient) {
    return true;
  }

  return false;
}

function stripTrailingSourcesSection(value: string): string {
  return value
    .replace(/\n{2,}(sources?|kaynaklar?)\s*:\s*[\s\S]*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizeAssistantAnswer(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return '';
  }

  const cleaned = normalized
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;

      return ![
        /^\[LLM synthesis fallback reason:[^\]]*\]$/i,
        /^Plan:\s*(?:[a-z_][a-z0-9_\/-]*)(?:\s*,\s*[a-z_][a-z0-9_\/-]*)*\s*$/i,
        /^Verifier:\s*.+$/i,
        /^Source preference:\s*(?:include sources|no source list)\s*$/i,
        /^Evidence(?: \(internal use only\))?:\s*$/i,
        /^Tool:\s*[a-z_][a-z0-9_:-]*\s*$/i,
        /^Summary:\s*$/i,
        /^Citations:\s*.*$/i,
        /^-{3,}\s*$/
      ].some((pattern) => pattern.test(trimmed));
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned;
}

function formatSources(citations: string[]): string {
  return `Kaynaklar:\n${citations.map((c) => `- ${c}`).join('\n')}`;
}

function fallbackSynthesis(params: {
  query: string;
  plan: Plan;
  verification: VerificationResult;
  results: ToolResult[];
}): string {
  if (params.results.length === 0) {
    return 'Yeterli bulgu toplanamadı. Sorguyu biraz daha netleştirirsen daha güçlü bir yanıt üretebilirim.';
  }

  const merged = params.results
    .map((r) => r.summary.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join('\n\n');

  const caveat = params.verification.sufficient
    ? ''
    : '\n\nNot: Bu yanıt mevcut kanıtlara dayanır; gerekirse bir ek doğrulama turu daha çalıştırabilirim.';

  return `${merged}${caveat}`.trim();
}

export async function synthesizeAnswer(params: {
  query: string;
  model: string;
  openRouterApiKey?: string;
  plan: Plan;
  verification: VerificationResult;
  results: ToolResult[];
  signal?: AbortSignal;
}): Promise<{ text: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number }; model: string }> {
  const evidence = buildEvidenceBlock(params.results);
  const citations = dedupe(params.results.flatMap((r) => r.citations));
  const includeSources = shouldAttachSources({
    query: params.query,
    verification: params.verification,
    hasCitations: citations.length > 0
  });

  if (!params.openRouterApiKey) {
    const base = fallbackSynthesis(params);
    const text = includeSources && citations.length > 0 ? `${base}\n\n${formatSources(citations)}` : base;
    return {
      text: sanitizeAssistantAnswer(text),
      model: 'local-fallback',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    };
  }

  try {
    const completion = await chatWithOpenRouter({
      apiKey: params.openRouterApiKey,
      model: params.model || config.openRouter.defaultModel,
      signal: params.signal,
      messages: [
        {
          role: 'system',
          content: [
            'You are SMART-AI synthesis agent.',
            'Use provided evidence only; do not invent facts.',
            'Think internally with a Poetiq-like method: (1) Intent Mirror (2) Evidence Weave (3) Counter-check (4) Crisp Delivery.',
            'Final answer must read like a clean LLM assistant answer, not an audit log.',
            'Do not expose plan/tool internals unless explicitly requested.',
            'Never repeat internal labels such as Plan, Verifier, Evidence, Tool, Summary, or Citations in the final answer.',
            'Do not include links/sources unless user explicitly asked for them.'
          ].join(' ')
        },
        {
          role: 'user',
          content: [
            `User Query: ${params.query}`,
            '',
            'Evidence (internal use only):',
            evidence,
            '',
            includeSources
              ? 'User explicitly asked for sources. Add a short source list at the end.'
              : 'Do not add a source list.',
            'Write final answer in Turkish unless query explicitly asks another language.'
          ].join('\n')
        }
      ]
    });

    const cleanedAnswer = sanitizeAssistantAnswer(completion.text);
    const normalized = includeSources ? cleanedAnswer : stripTrailingSourcesSection(cleanedAnswer);
    const withSources = includeSources && citations.length > 0 ? `${normalized}\n\n${formatSources(citations)}` : normalized;

    return {
      text: withSources,
      model: completion.model,
      usage: completion.usage
    };
  } catch (error) {
    const fallback = fallbackSynthesis(params);
    const fallbackWithSources = includeSources && citations.length > 0 ? `${fallback}\n\n${formatSources(citations)}` : fallback;
    void error;

    return {
      text: sanitizeAssistantAnswer(fallbackWithSources),
      model: 'local-fallback',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    };
  }
}

export const __private__ = {
  userExplicitlyAskedForSources,
  shouldAttachSources,
  stripTrailingSourcesSection,
  sanitizeAssistantAnswer
};
