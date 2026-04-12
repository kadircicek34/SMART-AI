import { chatWithOpenRouter, type LlmMessage, type LlmResponse } from '../llm/openrouter-client.js';
import type { ChatMessage } from './types.js';

type NonToolChatMessage = ChatMessage & { role: 'system' | 'user' | 'assistant' };

export type PromptProfile = {
  complexity: 'simple' | 'complex';
  useEnrichment: boolean;
  useTwoPass: boolean;
  reasons: string[];
};

export type DirectAnswerPhase = 'single-pass' | 'analysis-pass';

const COMPLEX_ANALYSIS_KEYWORDS = [
  'karşılaştır',
  'compare',
  'trade-off',
  'tradeoff',
  'alternatif',
  'mimari',
  'architecture',
  'strateji',
  'strategy',
  'tasarla',
  'design',
  'root cause',
  'kök neden',
  'araştır',
  'research',
  'derin',
  'deep',
  'plan',
  'roadmap',
  'adım adım',
  'step by step'
];

const EXPERT_PERSONA_SYSTEM_PROMPT = [
  'You are SMART-AI expert answer engine.',
  'Operate like a senior domain expert with strong reasoning, sharp judgment, and clean communication.',
  'Understand the user\'s real goal before answering.',
  'Preserve nuance, constraints, and requested tone.',
  'Prefer clear, high-signal answers over generic filler.',
  'When information is missing, state the gap briefly instead of inventing facts.',
  'Default to Turkish unless the conversation explicitly asks for another language.'
].join(' ');

function isNonToolMessage(message: ChatMessage): message is NonToolChatMessage {
  return message.role !== 'tool' && Boolean(message.content?.trim());
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function countQuestions(value: string): number {
  return (value.match(/\?/g) ?? []).length;
}

function hasComplexKeyword(value: string): boolean {
  const lower = value.toLowerCase();
  return COMPLEX_ANALYSIS_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function hasStructuredMultiPartPrompt(value: string): boolean {
  return /(^|\n)\s*(?:[-*]|\d+[.)])\s+/.test(value);
}

function buildRelevantContext(messages: ChatMessage[], maxMessages = 4): string {
  const conversation = messages.filter(isNonToolMessage);
  const lastUserIndex = [...conversation].reverse().findIndex((message) => message.role === 'user');

  if (lastUserIndex < 0) {
    return '';
  }

  const userIndex = conversation.length - 1 - lastUserIndex;
  return conversation
    .slice(Math.max(0, userIndex - maxMessages), userIndex)
    .map((message) => `${message.role}: ${message.content.trim()}`)
    .join('\n');
}

function detectExplicitConstraints(query: string): string[] {
  const constraints: string[] = [];

  if (/(kısa|kısaca|özet|brief|short|tl;dr)/i.test(query)) {
    constraints.push('Yanıt kısa ve öz tutulmalı.');
  }

  if (/(detaylı|ayrıntılı|deep|derin)/i.test(query)) {
    constraints.push('Yanıt yüzeysel kalmamalı, yeterli derinlik sağlamalı.');
  }

  if (/(adım adım|step by step)/i.test(query)) {
    constraints.push('Uygun yerde adım adım yapı korunmalı.');
  }

  if (/(karşılaştır|compare|trade.?off|alternatif)/i.test(query)) {
    constraints.push('Seçenekler trade-offlarıyla kıyaslanmalı.');
  }

  if (/(tablo|table|madde|bullet|liste)/i.test(query)) {
    constraints.push('Yanıt yapılandırılmış formatta sunulmalı.');
  }

  if (/(kaynak|source|citation|referans|link)/i.test(query)) {
    constraints.push('Kaynak beklentisi varsa doğrulanabilir referans korunmalı.');
  }

  if (/(ingilizce|english)/i.test(query)) {
    constraints.push('Yanıt İngilizce olmalı.');
  }

  if (/(türkçe|turkish)/i.test(query)) {
    constraints.push('Yanıt Türkçe olmalı.');
  }

  return dedupe(constraints);
}

export function toLlmConversation(
  messages: ChatMessage[],
  maxRecentMessages = 10,
  options?: {
    includePersona?: boolean;
    enrichLastUser?: boolean;
    promptProfile?: PromptProfile;
    additionalSystemInstructions?: string[];
  }
): LlmMessage[] {
  const filtered = messages.filter(isNonToolMessage).map((message) => ({
    role: message.role,
    content: message.content.trim()
  }));

  const systemMessages = filtered.filter((message) => message.role === 'system');
  const nonSystemMessages = filtered.filter((message) => message.role !== 'system');
  const recentMessages = nonSystemMessages.slice(-maxRecentMessages);
  const includePersona = options?.includePersona ?? true;
  const additionalSystemInstructions = options?.additionalSystemInstructions ?? [];

  if (options?.enrichLastUser && options.promptProfile?.useEnrichment) {
    const lastUserIndex = [...recentMessages].reverse().findIndex((message) => message.role === 'user');
    if (lastUserIndex >= 0) {
      const actualIndex = recentMessages.length - 1 - lastUserIndex;
      recentMessages[actualIndex] = {
        ...recentMessages[actualIndex],
        content: buildEnrichedUserQuery({
          query: recentMessages[actualIndex]?.content ?? '',
          messages,
          promptProfile: options.promptProfile
        })
      };
    }
  }

  const personaMessages = includePersona
    ? [{ role: 'system' as const, content: EXPERT_PERSONA_SYSTEM_PROMPT }]
    : [];

  const extraSystemMessages = additionalSystemInstructions.map((content) => ({ role: 'system' as const, content }));

  return [...personaMessages, ...systemMessages, ...extraSystemMessages, ...recentMessages];
}

export function buildPlanningQuery(messages: ChatMessage[]): string {
  const conversation = messages.filter(isNonToolMessage);
  const lastUserIndex = [...conversation].reverse().findIndex((message) => message.role === 'user');

  if (lastUserIndex < 0) {
    return 'No query provided.';
  }

  const userIndex = conversation.length - 1 - lastUserIndex;
  const lastUser = conversation[userIndex]?.content?.trim() || 'No query provided.';
  const referentialFollowUp =
    lastUser.length < 70 ||
    /^(bunu|şunu|onu|bunlar|şunlar|aynı|peki|ya peki|devam|buna göre|onu biraz|bunu biraz|daha|neden|nasıl)/i.test(lastUser);

  if (!referentialFollowUp) {
    return lastUser;
  }

  const contextWindow = conversation
    .slice(Math.max(0, userIndex - 2), userIndex)
    .map((message) => `${message.role}: ${message.content.trim()}`)
    .join('\n');

  return contextWindow ? `${contextWindow}\nuser: ${lastUser}` : lastUser;
}

export function classifyPromptProfile(params: {
  query: string;
  planningQuery?: string;
  messages: ChatMessage[];
  toolCount?: number;
}): PromptProfile {
  const reasons: string[] = [];
  const query = params.query.trim();
  const planningQuery = params.planningQuery?.trim() ?? query;
  const questionCount = countQuestions(query);

  if ((params.toolCount ?? 0) > 0) {
    reasons.push('external-evidence-route');
  }

  if (hasComplexKeyword(query)) {
    reasons.push('analysis-keyword');
  }

  if (hasStructuredMultiPartPrompt(query)) {
    reasons.push('structured-multipart');
  }

  if (query.length >= 220) {
    reasons.push('long-query');
  }

  if (questionCount >= 2) {
    reasons.push('multi-question');
  }

  if (planningQuery && planningQuery !== query) {
    reasons.push('context-dependent-followup');
  }

  const hardSignals = reasons.filter((reason) =>
    ['external-evidence-route', 'analysis-keyword', 'structured-multipart'].includes(reason)
  );
  const softSignals = reasons.filter((reason) => ['long-query', 'multi-question', 'context-dependent-followup'].includes(reason));
  const complexity = hardSignals.length > 0 || softSignals.length >= 2 ? 'complex' : 'simple';

  return {
    complexity,
    useEnrichment: complexity === 'complex',
    useTwoPass: complexity === 'complex',
    reasons
  };
}

export function buildEnrichedUserQuery(params: {
  query: string;
  messages: ChatMessage[];
  promptProfile?: PromptProfile;
}): string {
  if (!params.promptProfile?.useEnrichment) {
    return params.query;
  }

  const query = params.query.trim();
  const objective = buildPlanningQuery(params.messages);
  const context = buildRelevantContext(params.messages);
  const constraints = detectExplicitConstraints(query);

  return [
    'Internal prompt expansion derived only from the conversation below. Do not invent new facts.',
    `Original user request:\n${query}`,
    objective && objective !== query ? `Resolved objective:\n${objective}` : '',
    context ? `Relevant recent context:\n${context}` : '',
    constraints.length > 0 ? `Explicit response constraints:\n${constraints.map((item) => `- ${item}`).join('\n')}` : '',
    'Produce the strongest possible answer for the user. Preserve nuance, constraints, and requested tone.'
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function userAskedForBrevity(query: string): boolean {
  return /(kısa|kısaca|özet|brief|short|tek cümle|kısalt|too long; didn't read|tl;dr)/i.test(query);
}

function buildDirectAnswerInstructions(phase: DirectAnswerPhase, promptProfile?: PromptProfile): string[] {
  if (phase !== 'analysis-pass' || !promptProfile?.useTwoPass) {
    return [];
  }

  return [
    'This is pass 1 of 2 for a complex user request.',
    'Produce a high-signal working draft with strong coverage, important constraints, trade-offs, and concrete substance.',
    'Do not mention that this is an internal draft or a multi-pass process.'
  ];
}

export async function generateDirectAnswer(params: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  promptProfile?: PromptProfile;
  phase?: DirectAnswerPhase;
}): Promise<LlmResponse> {
  const phase = params.phase ?? 'single-pass';

  return chatWithOpenRouter({
    apiKey: params.apiKey,
    model: params.model,
    messages: toLlmConversation(params.messages, 10, {
      includePersona: true,
      enrichLastUser: phase === 'analysis-pass',
      promptProfile: params.promptProfile,
      additionalSystemInstructions: buildDirectAnswerInstructions(phase, params.promptProfile)
    }),
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    signal: params.signal
  });
}

export const __private__ = {
  hasComplexKeyword,
  hasStructuredMultiPartPrompt,
  buildRelevantContext,
  detectExplicitConstraints
};
