import test from 'node:test';
import assert from 'node:assert/strict';

import { __private__, runOrchestrator } from '../../orchestrator/run.js';

test('runOrchestrator uses direct model mode and preserves conversation context when no external evidence is needed', async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | undefined;

  globalThis.fetch = (async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        model: 'openai/gpt-4.1',
        choices: [{ message: { content: 'Elbette, teşekkür mesajını hazırladım.' } }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 18,
          total_tokens: 30
        }
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      }
    );
  }) as typeof fetch;

  try {
    const out = await runOrchestrator({
      tenantId: 'tenant-test',
      model: 'openai/gpt-4.1',
      openRouterApiKey: 'test-key',
      messages: [
        { role: 'system', content: 'Sen profesyonel ama sıcak bir asistansın.' },
        { role: 'assistant', content: 'Hazırım, nasıl yardımcı olayım?' },
        { role: 'user', content: 'Bana profesyonel ama samimi bir teşekkür mesajı yaz.' }
      ]
    });

    const payloadMessages = (capturedBody?.messages as Array<{ role: string; content: string }>) ?? [];

    assert.equal(out.text, 'Elbette, teşekkür mesajını hazırladım.');
    assert.equal(out.plan.tools.length, 0);
    assert.match(out.plan.reasoning, /Direct model mode/i);
    assert.equal(payloadMessages.some((message) => message.role === 'system' && /profesyonel ama sıcak/.test(message.content)), true);
    assert.equal(payloadMessages.some((message) => message.role === 'assistant' && /Hazırım/.test(message.content)), true);
    assert.equal(payloadMessages.some((message) => message.role === 'user' && /teşekkür mesajı/.test(message.content)), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('draft fallback wins when synthesis becomes much weaker without strong evidence', () => {
  const preferred = __private__.shouldPreferDraftAnswer({
    query: 'Bu yanıtı zengin bırak, kısaltma.',
    draftAnswer:
      'Bu çözümün ana avantajı, hem bakım maliyetini düşürmesi hem de ekiplerin aynı ürün vizyonu üzerinde hızlı iterasyon yapabilmesidir. Ayrıca geçiş riskini kontrollü tutar.',
    synthesizedAnswer: 'Avantajı bakım maliyetini düşürmesidir.',
    verification: {
      sufficient: false,
      confidence: 0.41,
      reason: 'Evidence still low after available tools.'
    },
    toolResults: [
      {
        tool: 'web_search',
        summary: 'failed: upstream timeout',
        citations: []
      }
    ]
  });

  assert.equal(preferred, true);
});

test('draft fallback does not override when user explicitly asked for brevity', () => {
  const preferred = __private__.shouldPreferDraftAnswer({
    query: 'Kısa cevap ver.',
    draftAnswer:
      'Bu çözümün ana avantajı, hem bakım maliyetini düşürmesi hem de ekiplerin aynı ürün vizyonu üzerinde hızlı iterasyon yapabilmesidir. Ayrıca geçiş riskini kontrollü tutar.',
    synthesizedAnswer: 'Bakım maliyetini düşürür.',
    verification: {
      sufficient: false,
      confidence: 0.41,
      reason: 'Evidence still low after available tools.'
    },
    toolResults: [
      {
        tool: 'web_search',
        summary: 'partial evidence collected',
        citations: ['https://example.com/a']
      }
    ]
  });

  assert.equal(preferred, false);
});
