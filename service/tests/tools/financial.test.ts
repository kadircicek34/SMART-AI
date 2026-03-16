import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../config.js';
import { __private__, financialDeepSearchTool } from '../../tools/financial.js';

const originalFetch = globalThis.fetch;
const originalBraveApiKey = config.tools.braveApiKey;

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.tools.braveApiKey = originalBraveApiKey;
});

test('financial parser extracts multiple symbols from alias and ticker tokens', () => {
  const symbols = __private__.parseTickers('Apple, NVDA ve $MSFT için finansal karşılaştırma');

  assert.ok(symbols.includes('AAPL'));
  assert.ok(symbols.includes('NVDA'));
  assert.ok(symbols.includes('MSFT'));
});

test('financial parser normalizes alpha vantage quote payload', () => {
  const parsed = __private__.parseAlphaVantageQuote('MSFT', {
    'Global Quote': {
      '01. symbol': 'MSFT',
      '02. open': '401.0000',
      '03. high': '404.8000',
      '04. low': '394.2500',
      '05. price': '395.5500',
      '06. volume': '26848000',
      '07. latest trading day': '2026-03-13',
      '08. previous close': '401.8600',
      '09. change': '-6.3100',
      '10. change percent': '-1.5702%'
    }
  });

  assert.ok(parsed);
  assert.equal(parsed?.symbol, 'MSFT');
  assert.equal(parsed?.source, 'alpha_vantage');
  assert.equal(parsed?.price, 395.55);
  assert.equal(parsed?.changePercent, -1.5702);
});

test('financial tool combines quote providers and appends news summary', async () => {
  config.tools.braveApiKey = undefined;

  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes('stooq.com')) {
      return new Response('Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-03-15,22:00:00,199.50,201.20,198.10,200.75,12345678', {
        status: 200,
        headers: { 'content-type': 'text/csv' }
      });
    }

    if (url.includes('alphavantage.co')) {
      return new Response(
        JSON.stringify({
          'Global Quote': {
            '01. symbol': 'AAPL',
            '02. open': '199.5000',
            '03. high': '201.2000',
            '04. low': '198.1000',
            '05. price': '200.7000',
            '06. volume': '12340000',
            '07. latest trading day': '2026-03-15',
            '08. previous close': '198.9000',
            '09. change': '1.8000',
            '10. change percent': '0.9050%'
          }
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }
      );
    }

    if (url.includes('api.duckduckgo.com')) {
      return new Response(
        JSON.stringify({
          AbstractText: 'Apple shares moved after analyst updates.',
          AbstractURL: 'https://duckduckgo.com/apple',
          RelatedTopics: [
            {
              Text: 'Apple expands services business in 2026 outlook.',
              FirstURL: 'https://example.com/apple-news'
            }
          ]
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }
      );
    }

    return new Response('not found', { status: 404 });
  };

  const result = await financialDeepSearchTool.execute({ query: 'AAPL son durum ve riskler' });

  assert.equal(result.tool, 'financial_deep_search');
  assert.match(result.summary, /AAPL/);
  assert.match(result.summary, /provider spread/i);
  assert.match(result.summary, /Haber özeti:/);
  assert.ok(result.citations.some((citation) => citation.includes('stooq.com')));
  assert.ok(result.citations.some((citation) => citation.includes('alphavantage.co')));
});
