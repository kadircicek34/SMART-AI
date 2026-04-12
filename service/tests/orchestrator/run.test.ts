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
    assert.match(out.plan.reasoning, /expert-persona/i);
    assert.equal(payloadMessages.some((message) => message.role === 'system' && /SMART-AI expert answer engine/i.test(message.content)), true);
    assert.equal(payloadMessages.some((message) => message.role === 'system' && /profesyonel ama sıcak/.test(message.content)), true);
    assert.equal(payloadMessages.some((message) => message.role === 'assistant' && /Hazırım/.test(message.content)), true);
    assert.equal(payloadMessages.some((message) => message.role === 'user' && /teşekkür mesajı/.test(message.content)), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runOrchestrator uses two-pass generation for context-heavy follow-ups without forcing tools', async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    bodies.push(body);
    const messages = (body.messages as Array<{ role: string; content: string }>) ?? [];
    const combined = messages.map((message) => message.content).join('\n');

    const content = /Base draft answer/.test(combined)
      ? 'Önerilen yön şu, çünkü geçişi iki faza bölmek operasyon riskini düşürür.'
      : /İlk 90 günde rollout'u nasıl yaparız\?/.test(combined)
        ? 'İlk çalışma taslağı: geçiş sırası, riskler ve ekip bağımlılıklarını çıkarıyorum.'
        : 'Paralel test çağrısı';

    return new Response(
      JSON.stringify({
        model: 'deepseek/deepseek-v3.2',
        choices: [{ message: { content } }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 20,
          total_tokens: 40
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
      model: 'deepseek/deepseek-v3.2',
      openRouterApiKey: 'test-key',
      messages: [
        { role: 'assistant', content: 'İki ekip modeli konuştuk: tek ekip geçişi ve kademeli iki ekip geçişi.' },
        { role: 'user', content: "Peki hangisi daha güvenli? İlk 90 günde rollout'u nasıl yaparız?" }
      ]
    });

    assert.equal(out.plan.tools.length, 0);
    assert.equal(out.text, 'Önerilen yön şu, çünkü geçişi iki faza bölmek operasyon riskini düşürür.');
    assert.match(out.plan.reasoning, /two-pass/i);

    const relevantBodies = bodies.filter((body) => {
      const messages = (body.messages as Array<{ role: string; content: string }>) ?? [];
      return messages.some((message) => /İlk 90 günde rollout'u nasıl yaparız\?|Base draft answer/.test(message.content));
    });

    assert.equal(relevantBodies.length >= 2, true);

    const firstMessages = (relevantBodies.find((body) => {
      const messages = (body.messages as Array<{ role: string; content: string }>) ?? [];
      return messages.some((message) => /Internal prompt expansion/.test(message.content));
    })?.messages as Array<{ role: string; content: string }>) ?? [];

    const secondMessages = (relevantBodies.find((body) => {
      const messages = (body.messages as Array<{ role: string; content: string }>) ?? [];
      return messages.some((message) => /Base draft answer/.test(message.content));
    })?.messages as Array<{ role: string; content: string }>) ?? [];

    assert.equal(firstMessages.some((message) => message.role === 'user' && /Internal prompt expansion/.test(message.content)), true);
    assert.equal(secondMessages.some((message) => message.role === 'user' && /Base draft answer/.test(message.content)), true);
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

test('draft fallback allows second-pass refinement when no tools were used', () => {
  const preferred = __private__.shouldPreferDraftAnswer({
    query: 'Bu mimariyi trade-offlarıyla karşılaştır ve öner.',
    draftAnswer:
      'İlk taslak oldukça uzun, kapsamlı ve birden fazla trade-off içeriyor. Ayrıca önerilen geçiş stratejisini de açıklıyor.',
    synthesizedAnswer: 'Son yön şu, çünkü daha temiz.',
    verification: {
      sufficient: true,
      confidence: 0.9,
      reason: 'Complex prompt routed through direct two-pass generation.'
    },
    toolResults: [],
    allowNoToolSecondPass: true
  });

  assert.equal(preferred, false);
});
