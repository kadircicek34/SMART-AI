import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../config.js';
import { __private__, openbbSearchTool } from '../../tools/openbb-search.js';

const originalFetch = globalThis.fetch;
const originalOpenbbState = {
  openbbEnabled: config.tools.openbbEnabled,
  openbbApiBaseUrl: config.tools.openbbApiBaseUrl,
  openbbApiPrefix: config.tools.openbbApiPrefix,
  openbbApiTimeoutMs: config.tools.openbbApiTimeoutMs,
  openbbProvider: config.tools.openbbProvider,
  openbbNewsProvider: config.tools.openbbNewsProvider,
  openbbWorldNewsProvider: config.tools.openbbWorldNewsProvider,
  openbbAuthToken: config.tools.openbbAuthToken,
  openbbUsername: config.tools.openbbUsername,
  openbbPassword: config.tools.openbbPassword,
  openbbMaxSymbols: config.tools.openbbMaxSymbols,
  openbbHistoryLimit: config.tools.openbbHistoryLimit,
  openbbNewsLimit: config.tools.openbbNewsLimit
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(config.tools, originalOpenbbState);
});

test('openbb parser extracts symbols from alias and ticker tokens', () => {
  const symbols = __private__.parseTickers('Apple ve $NVDA için openbb trading analizi');

  assert.ok(symbols.includes('AAPL'));
  assert.ok(symbols.includes('NVDA'));
});

test('openbb tool returns disabled summary when integration is off', async () => {
  config.tools.openbbEnabled = false;
  const result = await openbbSearchTool.execute({ query: 'AAPL trading analizi' });

  assert.equal(result.tool, 'openbb_search');
  assert.match(result.summary, /devre dışı/i);
});

test('openbb tool composes quote + historical + company/world news summary', async () => {
  config.tools.openbbEnabled = true;
  config.tools.openbbApiBaseUrl = 'http://127.0.0.1:6900';
  config.tools.openbbApiPrefix = '/api/v1';
  config.tools.openbbProvider = 'yfinance';
  config.tools.openbbNewsProvider = 'benzinga';
  config.tools.openbbWorldNewsProvider = 'fmp';
  config.tools.openbbHistoryLimit = 10;
  config.tools.openbbNewsLimit = 3;

  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith('/api/v1/equity/price/quote')) {
      return new Response(
        JSON.stringify([
          {
            symbol: 'AAPL',
            last_price: 205.7,
            open: 201.2,
            high: 206.1,
            low: 200.9,
            volume: 1234000,
            date: '2026-03-19'
          }
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (url.pathname.endsWith('/api/v1/equity/price/historical')) {
      return new Response(
        JSON.stringify([
          { close: 198 },
          { close: 201 },
          { close: 203 },
          { close: 204 },
          { close: 205.7 }
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (url.pathname.endsWith('/api/v1/news/company')) {
      return new Response(
        JSON.stringify([
          { title: 'Apple launches new AI feature set' },
          { title: 'Analysts lift AAPL targets after guidance' }
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (url.pathname.endsWith('/api/v1/news/world')) {
      return new Response(
        JSON.stringify([
          { title: 'Fed minutes point to cautious easing path' },
          { title: 'Global equities rally on AI spending outlook' }
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    return new Response('not found', { status: 404 });
  };

  const result = await openbbSearchTool.execute({ query: 'AAPL için trading ve market data analizi yap' });

  assert.equal(result.tool, 'openbb_search');
  assert.match(result.summary, /AAPL:/);
  assert.match(result.summary, /world_news=/);
  assert.ok(result.citations.some((c) => c.includes('/api/v1/equity/price/quote')));
  assert.ok(result.citations.some((c) => c.includes('/api/v1/news/world')));
});
