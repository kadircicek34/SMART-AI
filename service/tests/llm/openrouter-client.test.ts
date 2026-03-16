import test from 'node:test';
import assert from 'node:assert/strict';

import { __private__, chatWithOpenRouter } from '../../llm/openrouter-client.js';

test('parseRetryAfterMs parses seconds and HTTP date values', () => {
  assert.equal(__private__.parseRetryAfterMs('1.5'), 1500);

  const futureDate = new Date(Date.now() + 2_000).toUTCString();
  const parsedFuture = __private__.parseRetryAfterMs(futureDate);
  assert.ok(parsedFuture !== null && parsedFuture >= 0 && parsedFuture <= 2_500);

  assert.equal(__private__.parseRetryAfterMs('invalid-date'), null);
  assert.equal(__private__.parseRetryAfterMs(null), null);
});

test('chatWithOpenRouter retries on 429 and succeeds on next attempt', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;

  let fetchCalls = 0;

  globalThis.fetch = (async () => {
    fetchCalls += 1;

    if (fetchCalls === 1) {
      return new Response('rate limit', {
        status: 429,
        headers: {
          'retry-after': '0'
        }
      });
    }

    return new Response(
      JSON.stringify({
        model: 'deepseek/deepseek-chat-v3.1',
        choices: [{ message: { content: 'ok' } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
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

  globalThis.setTimeout = ((handler: (...args: any[]) => void, _timeout?: number, ...args: any[]) => {
    handler(...args);
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;

  try {
    const response = await chatWithOpenRouter({
      apiKey: 'test-key',
      model: 'deepseek/deepseek-chat-v3.1',
      messages: [{ role: 'user', content: 'hello' }]
    });

    assert.equal(fetchCalls, 2);
    assert.equal(response.text, 'ok');
    assert.equal(response.usage.totalTokens, 30);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('chatWithOpenRouter does not retry on non-retryable failures', async () => {
  const originalFetch = globalThis.fetch;

  let fetchCalls = 0;

  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response('bad request', { status: 400 });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        chatWithOpenRouter({
          apiKey: 'test-key',
          model: 'deepseek/deepseek-chat-v3.1',
          messages: [{ role: 'user', content: 'hello' }]
        }),
      /OpenRouter request failed \(400\): bad request/
    );

    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
