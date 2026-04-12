import { chatWithOpenRouter, type LlmMessage, type LlmResponse } from '../llm/openrouter-client.js';
import type { ChatMessage } from './types.js';

type NonToolChatMessage = ChatMessage & { role: 'system' | 'user' | 'assistant' };

function isNonToolMessage(message: ChatMessage): message is NonToolChatMessage {
  return message.role !== 'tool' && Boolean(message.content?.trim());
}

export function toLlmConversation(messages: ChatMessage[], maxRecentMessages = 10): LlmMessage[] {
  const filtered = messages.filter(isNonToolMessage).map((message) => ({
    role: message.role,
    content: message.content.trim()
  }));

  const systemMessages = filtered.filter((message) => message.role === 'system');
  const nonSystemMessages = filtered.filter((message) => message.role !== 'system');
  const recentMessages = nonSystemMessages.slice(-maxRecentMessages);

  return [...systemMessages, ...recentMessages];
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

export function userAskedForBrevity(query: string): boolean {
  return /(kısa|kısaca|özet|brief|short|tek cümle|kısalt|too long; didn't read|tl;dr)/i.test(query);
}

export async function generateDirectAnswer(params: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<LlmResponse> {
  return chatWithOpenRouter({
    apiKey: params.apiKey,
    model: params.model,
    messages: toLlmConversation(params.messages),
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    signal: params.signal
  });
}
