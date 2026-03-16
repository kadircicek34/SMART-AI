import { config } from '../config.js';
import type { ToolAdapter, ToolInput, ToolResult } from './types.js';
import { webSearchTool } from './web-search.js';

const TICKER_ALIASES: Record<string, string> = {
  apple: 'AAPL',
  microsoft: 'MSFT',
  tesla: 'TSLA',
  nvidia: 'NVDA',
  amazon: 'AMZN',
  alphabet: 'GOOGL',
  google: 'GOOGL',
  meta: 'META',
  netflix: 'NFLX',
  amd: 'AMD',
  palantir: 'PLTR',
  aselsan: 'ASELS',
  thy: 'THYAO',
  koç: 'KCHOL',
  koc: 'KCHOL'
};

type QuoteSnapshot = {
  symbol: string;
  source: 'stooq' | 'alpha_vantage';
  price: number;
  open?: number;
  high?: number;
  low?: number;
  previousClose?: number;
  change?: number;
  changePercent?: number;
  volume?: number;
  asOf?: string;
};

type QuoteProvider = {
  name: QuoteSnapshot['source'];
  fetchQuote(symbol: string): Promise<{ quote: QuoteSnapshot | null; citation?: string }>;
};

type QuoteCacheEntry = {
  expiresAt: number;
  value: { quote: QuoteSnapshot | null; citation?: string };
};

const QUOTE_CACHE_TTL_MS = 30_000;
const MAX_SYMBOLS = 4;
const quoteCache = new Map<string, QuoteCacheEntry>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(String(value).replace(/,/g, '').replace('%', '').trim());
  return Number.isFinite(n) ? n : undefined;
}

function normalizeSymbol(raw: string): string {
  const upper = raw.trim().toUpperCase();
  if (!upper) return upper;
  return upper.replace(/[^A-Z0-9.]/g, '');
}

function parseTickers(query: string): string[] {
  const normalized = query.toLowerCase();
  const found = new Set<string>();

  for (const [alias, symbol] of Object.entries(TICKER_ALIASES)) {
    if (normalized.includes(alias)) {
      found.add(symbol);
    }
  }

  const explicit = query.match(/\$?[A-Z]{1,5}(?:\.[A-Z]{1,2})?/g) ?? [];
  for (const token of explicit) {
    const cleaned = normalizeSymbol(token.replace('$', ''));
    if (cleaned && cleaned.length <= 6) {
      found.add(cleaned);
    }
  }

  return [...found].slice(0, MAX_SYMBOLS);
}

type StooqQuote = {
  symbol: string;
  date: string;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function parseStooq(csv: string): StooqQuote | null {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return null;

  const cols = lines[1].split(',');
  if (cols.length < 8 || cols[3] === 'N/D') return null;

  const open = toNumber(cols[3]);
  const high = toNumber(cols[4]);
  const low = toNumber(cols[5]);
  const close = toNumber(cols[6]);
  const volume = toNumber(cols[7]);
  if ([open, high, low, close, volume].some((v) => v === undefined)) return null;

  return {
    symbol: cols[0],
    date: cols[1],
    time: cols[2],
    open: open as number,
    high: high as number,
    low: low as number,
    close: close as number,
    volume: volume as number
  };
}

type AlphaVantagePayload = {
  'Global Quote'?: Record<string, string>;
};

function parseAlphaVantageQuote(symbol: string, payload: AlphaVantagePayload): QuoteSnapshot | null {
  const q = payload['Global Quote'];
  if (!q || Object.keys(q).length === 0) return null;

  const price = toNumber(q['05. price']);
  if (!price) return null;

  return {
    symbol,
    source: 'alpha_vantage',
    price,
    open: toNumber(q['02. open']),
    high: toNumber(q['03. high']),
    low: toNumber(q['04. low']),
    previousClose: toNumber(q['08. previous close']),
    change: toNumber(q['09. change']),
    changePercent: toNumber(q['10. change percent']),
    volume: toNumber(q['06. volume']),
    asOf: q['07. latest trading day']
  };
}

function cacheKey(provider: QuoteSnapshot['source'], symbol: string): string {
  return `${provider}:${symbol}`;
}

async function withCache(
  provider: QuoteSnapshot['source'],
  symbol: string,
  loader: () => Promise<{ quote: QuoteSnapshot | null; citation?: string }>
): Promise<{ quote: QuoteSnapshot | null; citation?: string }> {
  const key = cacheKey(provider, symbol);
  const now = Date.now();
  const cached = quoteCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const value = await loader();
  quoteCache.set(key, {
    expiresAt: now + QUOTE_CACHE_TTL_MS,
    value
  });

  return value;
}

const stooqProvider: QuoteProvider = {
  name: 'stooq',
  async fetchQuote(symbol) {
    const stooqUrl = `https://stooq.com/q/l/?s=${symbol.toLowerCase()}.us&i=d`;

    return withCache('stooq', symbol, async () => {
      const response = await fetch(stooqUrl, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) {
        return { quote: null, citation: stooqUrl };
      }

      const csv = await response.text();
      const parsed = parseStooq(csv);
      if (!parsed) {
        return { quote: null, citation: stooqUrl };
      }

      const quote: QuoteSnapshot = {
        symbol,
        source: 'stooq',
        price: parsed.close,
        open: parsed.open,
        high: parsed.high,
        low: parsed.low,
        volume: parsed.volume,
        asOf: parsed.date,
        previousClose: undefined,
        change: undefined,
        changePercent: undefined
      };

      return { quote, citation: stooqUrl };
    });
  }
};

const alphaVantageProvider: QuoteProvider = {
  name: 'alpha_vantage',
  async fetchQuote(symbol) {
    const apiKey = config.tools.alphaVantageApiKey || 'demo';
    const url = new URL('https://www.alphavantage.co/query');
    url.searchParams.set('function', 'GLOBAL_QUOTE');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('apikey', apiKey);

    return withCache('alpha_vantage', symbol, async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) {
        return { quote: null, citation: url.toString() };
      }

      const json = (await response.json()) as AlphaVantagePayload;
      const quote = parseAlphaVantageQuote(symbol, json);
      return { quote, citation: url.toString() };
    });
  }
};

function formatPercent(value: number | undefined): string {
  if (value === undefined) return 'n/a';
  return `${value.toFixed(2)}%`;
}

function formatNumber(value: number | undefined): string {
  if (value === undefined) return 'n/a';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

function formatVolume(value: number | undefined): string {
  if (value === undefined) return 'n/a';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function choosePrimaryQuote(quotes: QuoteSnapshot[]): QuoteSnapshot | null {
  if (quotes.length === 0) return null;

  const alpha = quotes.find((q) => q.source === 'alpha_vantage');
  if (alpha) return alpha;

  return quotes[0];
}

function buildFinancialNewsQuery(symbols: string[], query: string): string {
  const prefix = symbols.length ? symbols.join(' ') : '';
  const normalized = `${prefix} stock market news ${query}`.trim();
  return normalized.length > 260 ? normalized.slice(0, 260) : normalized;
}

async function collectQuotes(symbol: string): Promise<{ quotes: QuoteSnapshot[]; citations: string[] }> {
  const providers: QuoteProvider[] = [stooqProvider, alphaVantageProvider];
  const quotes: QuoteSnapshot[] = [];
  const citations: string[] = [];

  for (const provider of providers) {
    try {
      const result = await provider.fetchQuote(symbol);
      if (result.citation) citations.push(result.citation);
      if (result.quote) quotes.push(result.quote);
    } catch {
      // keep going to next provider
    }
  }

  return {
    quotes,
    citations
  };
}

export const financialDeepSearchTool: ToolAdapter = {
  name: 'financial_deep_search',
  async execute(input: ToolInput): Promise<ToolResult> {
    const symbols = parseTickers(input.query);
    const lines: string[] = [];
    const citations: string[] = [];

    if (symbols.length > 0) {
      for (const symbol of symbols) {
        const quoteResult = await collectQuotes(symbol);
        citations.push(...quoteResult.citations);

        const primary = choosePrimaryQuote(quoteResult.quotes);
        if (!primary) {
          lines.push(`${symbol}: quote bulunamadı (provider fallback başarısız).`);
          continue;
        }

        const sourceNames = quoteResult.quotes.map((q) => q.source).join(', ');
        lines.push(
          `${symbol} @${primary.source}: price=${formatNumber(primary.price)}, open=${formatNumber(primary.open)}, high=${formatNumber(primary.high)}, low=${formatNumber(primary.low)}, prevClose=${formatNumber(primary.previousClose)}, change=${formatNumber(primary.change)} (${formatPercent(primary.changePercent)}), volume=${formatVolume(primary.volume)}, asOf=${primary.asOf ?? 'n/a'}`
        );

        if (quoteResult.quotes.length >= 2) {
          const minPrice = Math.min(...quoteResult.quotes.map((q) => q.price));
          const maxPrice = Math.max(...quoteResult.quotes.map((q) => q.price));
          const divergence = maxPrice > 0 ? ((maxPrice - minPrice) / maxPrice) * 100 : 0;
          lines.push(`${symbol} provider spread: ${divergence.toFixed(2)}% (sources: ${sourceNames})`);
        }
      }
    } else {
      lines.push('Ticker otomatik tespit edilemedi; finansal haber ve genel piyasa özeti üretildi.');
    }

    const newsQuery = buildFinancialNewsQuery(symbols, input.query);
    const news = await webSearchTool.execute({ query: newsQuery, locale: input.locale, tenantId: input.tenantId });
    lines.push('Haber özeti:');
    lines.push(news.summary);
    citations.push(...news.citations);

    return {
      tool: 'financial_deep_search',
      summary: lines.join('\n'),
      citations: [...new Set(citations)].slice(0, 40),
      raw: {
        symbols,
        providerCount: 2,
        newsQuery
      }
    };
  }
};

export const __private__ = {
  parseTickers,
  parseStooq,
  parseAlphaVantageQuote,
  choosePrimaryQuote,
  buildFinancialNewsQuery,
  formatPercent,
  formatNumber,
  formatVolume,
  clamp
};
