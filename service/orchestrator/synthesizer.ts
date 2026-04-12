import { config } from '../config.js';
import { chatWithOpenRouter } from '../llm/openrouter-client.js';
import type { ToolResult } from '../tools/types.js';
import { toLlmConversation } from './direct-answer.js';
import type { ChatMessage, Plan } from './types.js';
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

function normalizeInternalMarker(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^\*\*([^*]+):\*\*\s*/, '$1: ')
    .replace(/^\*\*([^*]+)\*\*:\s*/, '$1: ')
    .replace(/^\*\*(.+?)\*\*:?$/, '$1')
    .trim();
}

function isInternalAuditStart(line: string): boolean {
  const trimmed = normalizeInternalMarker(line);
  if (!trimmed) {
    return false;
  }

  return [
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
}

function stripTrailingInternalAuditBlock(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return '';
  }

  const lines = normalized.split('\n');
  const markerIndex = lines.findIndex((line) => isInternalAuditStart(line));
  if (markerIndex <= 0) {
    return normalized;
  }

  return lines.slice(0, markerIndex).join('\n').trim();
}

function sanitizeAssistantAnswer(value: string): string {
  const normalized = stripTrailingInternalAuditBlock(value);
  if (!normalized) {
    return '';
  }

  const cleaned = normalized
    .split('\n')
    .filter((line) => {
      const trimmed = normalizeInternalMarker(line);
      if (!trimmed) return true;

      return !isInternalAuditStart(trimmed);
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
  draftAnswer?: string;
}): string {
  if (params.draftAnswer?.trim()) {
    return sanitizeAssistantAnswer(params.draftAnswer);
  }

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

function buildSynthesisMessages(params: {
  query: string;
  messages: ChatMessage[];
  plan: Plan;
  verification: VerificationResult;
  evidence: string;
  includeSources: boolean;
  draftAnswer?: string;
}) {
  const conversation = toLlmConversation(params.messages, 6);
  const systemMessages = conversation.filter((message) => message.role === 'system');
  const contextMessages = conversation.filter((message) => message.role !== 'system');

  return [
    ...systemMessages,
    {
      role: 'system' as const,
      content: [
        'You are SMART-AI final answer agent.',
        'Preserve the intelligence, nuance, and helpfulness of the strongest available model.',
        'If a draft answer is provided, treat it as a quality floor and improve it only where verified evidence adds value.',
        'Do not dumb down, flatten, or over-shorten the answer.',
        'Use verified evidence to add accuracy, freshness, specificity, and confidence.',
        'Keep the user-requested tone, structure, and depth.',
        'Only add caveats when the evidence truly requires them.',
        'Do not expose plan/tool internals unless explicitly requested.',
        'Never repeat internal labels such as Plan, Verifier, Evidence, Tool, Summary, or Citations in the final answer.',
        'Do not include links/sources unless the user explicitly asked for them.'
      ].join(' ')
    },
    ...contextMessages,
    {
      role: 'user' as const,
      content: [
        'You are preparing the next assistant reply for the conversation above.',
        params.draftAnswer?.trim()
          ? `Base draft answer (quality floor, improve only if evidence truly helps):\n${params.draftAnswer.trim()}`
          : 'No draft answer is available, synthesize directly from the conversation and evidence.',
        `Planned evidence route: ${params.plan.tools.length > 0 ? params.plan.tools.join(', ') : 'none'}`,
        `Verification status: ${params.verification.reason}`,
        params.evidence
          ? `Verified evidence (internal use only):\n${params.evidence}`
          : 'No external evidence was collected. Preserve the strongest useful answer quality.',
        params.includeSources
          ? 'User explicitly asked for sources. Add a compact source list at the end.'
          : 'Do not add a source list or raw links unless the user explicitly asked for them.',
        'If the evidence is partial, stay helpful and honest without becoming robotic.',
        'Write final answer in Turkish unless the query explicitly asks another language.'
      ].join('\n\n')
    }
  ];
}

export async function synthesizeAnswer(params: {
  query: string;
  model: string;
  openRouterApiKey?: string;
  plan: Plan;
  verification: VerificationResult;
  results: ToolResult[];
  messages: ChatMessage[];
  draftAnswer?: string;
  temperature?: number;
  maxTokens?: number;
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
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      messages: buildSynthesisMessages({
        query: params.query,
        messages: params.messages,
        plan: params.plan,
        verification: params.verification,
        evidence,
        includeSources,
        draftAnswer: params.draftAnswer
      })
    });

    const cleanedAnswer = sanitizeAssistantAnswer(completion.text) || sanitizeAssistantAnswer(params.draftAnswer ?? '');
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
  stripTrailingInternalAuditBlock,
  isInternalAuditStart,
  sanitizeAssistantAnswer
};
