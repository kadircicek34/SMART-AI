import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../config.js';
import { webSearchTool } from '../../tools/web-search.js';

const originalFetch = globalThis.fetch;
const originalBraveApiKey = config.tools.braveApiKey;

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.tools.braveApiKey = originalBraveApiKey;
});

test('web_search uses Brave provider when BRAVE_API_KEY is configured', async () => {
  config.tools.braveApiKey = 'test-brave-token';

  let calledUrl = '';

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calledUrl = String(input);

    return new Response(
      JSON.stringify({
        web: {
          results: [
            {
              title: 'Brave Result',
              url: 'https://example.com/brave',
              description: 'Brave powered search summary.'
            }
          ]
        }
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }
    );
  }) as typeof fetch;

  const result = await webSearchTool.execute({ query: 'smart ai' });

  assert.match(calledUrl, /api\.search\.brave\.com/);
  assert.match(result.summary, /Brave Result/);
  assert.deepEqual(result.citations, ['https://example.com/brave']);
});

test('web_search falls back to DuckDuckGo when Brave call fails', async () => {
  config.tools.braveApiKey = 'test-brave-token';

  let callCount = 0;

  globalThis.fetch = (async () => {
    callCount += 1;

    if (callCount === 1) {
      return new Response('fail', { status: 503 });
    }

    return new Response(
      JSON.stringify({
        AbstractText: 'Duck fallback response',
        AbstractURL: 'https://duck.example/answer',
        RelatedTopics: []
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }
    );
  }) as typeof fetch;

  const result = await webSearchTool.execute({ query: 'fallback search' });

  assert.ok(callCount >= 2);
  assert.match(result.summary, /Duck fallback response/);
  assert.ok(result.citations.includes('https://duck.example/answer'));
});
