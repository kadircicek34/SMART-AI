import test from 'node:test';
import assert from 'node:assert/strict';

import { routeIntent } from '../../orchestrator/intent-router.js';

const ROUTES: Record<string, { tools: string[]; concrete: string[] }> = {
  'Merhaba nasılsın': { tools: ['direct_answer'], concrete: [] },
  'İş sözleşmesi feshi': { tools: ['mevzuat_rag', 'direct_answer'], concrete: ['mevzuat_mcp_search'] },
  'Yargıtay’ın kira uyuşmazlıklarındaki son kararları': { tools: ['yargi_mcp', 'web_search'], concrete: ['yargi_mcp_search', 'web_search'] },
  'Bugün dolar kaç TL': { tools: ['web_search'], concrete: ['web_search'] },
  'BIST 100 son durum': { tools: ['borsa_mcp', 'web_search'], concrete: ['borsa_mcp_search', 'web_search'] },
  'Bu projede hangi endpoint var': { tools: ['qmd_search'], concrete: ['qmd_search'] },
  'Kıdem tazminatı nasıl hesaplanır': { tools: ['mevzuat_rag', 'direct_answer'], concrete: ['mevzuat_mcp_search'] },
  'AYM’nin bireysel başvuru istatistikleri': { tools: ['web_search', 'yargi_mcp'], concrete: ['web_search', 'yargi_mcp_search'] }
};

test('intent router uses fast fixed request settings and disables reasoning', async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | undefined;

  globalThis.fetch = (async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        model: 'deepseek/deepseek-v3.2',
        choices: [
          {
            message: {
              content: '{"tools":["direct_answer"],"confidence":0.97,"reasoning":"selamlama rotası"}'
            }
          }
        ],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 5,
          total_tokens: 10
        }
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }
    );
  }) as typeof fetch;

  try {
    const route = await routeIntent({
      apiKey: 'test-key',
      query: 'Merhaba nasılsın'
    });

    assert.deepEqual(route?.semanticTools, ['direct_answer']);
    assert.equal(capturedBody?.temperature, 0);
    assert.equal(capturedBody?.max_tokens, 150);
    assert.equal('reasoning' in (capturedBody ?? {}), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('intent router maps requested scenarios into concrete planner tools', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: Array<{ role: string; content: string }>;
    };
    const query = body.messages?.find((message) => message.role === 'user')?.content.replace(/^Kullanıcı sorusu:\n/, '') ?? '';
    const matched = ROUTES[query];

    if (!matched) {
      throw new Error(`Unexpected query: ${query}`);
    }

    return new Response(
      JSON.stringify({
        model: 'deepseek/deepseek-v3.2',
        choices: [
          {
            message: {
              content: JSON.stringify({
                tools: matched.tools,
                confidence: 0.91,
                reasoning: 'uygun rota seçildi'
              })
            }
          }
        ],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 5,
          total_tokens: 10
        }
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }
    );
  }) as typeof fetch;

  try {
    for (const [query, expected] of Object.entries(ROUTES)) {
      const route = await routeIntent({
        apiKey: 'test-key',
        query
      });

      assert.deepEqual(route?.semanticTools, expected.tools, query);
      assert.deepEqual(route?.planTools, expected.concrete, query);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
