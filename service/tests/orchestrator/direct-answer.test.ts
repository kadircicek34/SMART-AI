import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEnrichedUserQuery, classifyPromptProfile, toLlmConversation } from '../../orchestrator/direct-answer.js';

test('classifyPromptProfile keeps short writing prompts simple', () => {
  const profile = classifyPromptProfile({
    query: 'Bana kısa bir teşekkür mesajı yaz.',
    messages: [{ role: 'user', content: 'Bana kısa bir teşekkür mesajı yaz.' }],
    toolCount: 0
  });

  assert.equal(profile.complexity, 'simple');
  assert.equal(profile.useEnrichment, false);
  assert.equal(profile.useTwoPass, false);
});

test('classifyPromptProfile marks strategy questions complex', () => {
  const profile = classifyPromptProfile({
    query: 'Bu mimariyi trade-offlarıyla karşılaştır ve hangi yönü seçmemiz gerektiğini açıkla.',
    messages: [{ role: 'user', content: 'Bu mimariyi trade-offlarıyla karşılaştır ve hangi yönü seçmemiz gerektiğini açıkla.' }],
    toolCount: 0
  });

  assert.equal(profile.complexity, 'complex');
  assert.equal(profile.useEnrichment, true);
  assert.equal(profile.useTwoPass, true);
  assert.match(profile.reasons.join(','), /analysis-keyword/);
});

test('buildEnrichedUserQuery derives objective and constraints only for complex prompts', () => {
  const messages = [
    { role: 'assistant' as const, content: 'Hedefimiz kaliteyi yükseltmek.' },
    { role: 'user' as const, content: 'Bu akışı trade-offlarıyla karşılaştır, kısa ama net anlat.' }
  ];
  const profile = classifyPromptProfile({
    query: messages[1].content,
    messages,
    toolCount: 1
  });

  const enriched = buildEnrichedUserQuery({
    query: messages[1].content,
    messages,
    promptProfile: profile
  });

  assert.match(enriched, /Original user request:/);
  assert.match(enriched, /Relevant recent context:/);
  assert.match(enriched, /Explicit response constraints:/);
  assert.match(enriched, /Yanıt kısa ve öz tutulmalı/);
});

test('toLlmConversation prepends expert persona and enriches last user message only when requested', () => {
  const messages = [
    { role: 'system' as const, content: 'Cevaplar profesyonel olsun.' },
    { role: 'assistant' as const, content: 'Hazırım.' },
    { role: 'user' as const, content: 'Bu mimariyi karşılaştır ve öner.' }
  ];
  const profile = classifyPromptProfile({
    query: 'Bu mimariyi karşılaştır ve öner.',
    messages,
    toolCount: 0
  });

  const conversation = toLlmConversation(messages, 10, {
    includePersona: true,
    enrichLastUser: true,
    promptProfile: profile,
    additionalSystemInstructions: ['This is pass 1 of 2.']
  });

  assert.equal(conversation[0]?.role, 'system');
  assert.match(conversation[0]?.content ?? '', /SMART-AI expert answer engine/i);
  assert.equal(conversation.some((message) => message.role === 'system' && /This is pass 1 of 2/.test(message.content)), true);
  const lastUser = [...conversation].reverse().find((message) => message.role === 'user');
  assert.match(lastUser?.content ?? '', /Internal prompt expansion/);
});
