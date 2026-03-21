import { config } from '../config.js';
import { createTimeoutSignal, throwIfAborted } from '../utils/abort.js';
import type { ToolAdapter, ToolInput, ToolResult } from './types.js';

type JsonRecord = Record<string, unknown>;

type OpenbbCallResult = {
  ok: boolean;
  status: number;
  url: string;
  data: unknown;
  error?: string;
};

type SymbolInsight = {
  symbol: string;
  quote?: {
    price?: number;
    open?: number;
    high?: number;
    low?: number;
    volume?: number;
    asOf?: string;
  };
  trend?: {
    points: number;
    pct1d?: number;
    pct5d?: number;
  };
  companyNewsTitles: string[];
  errors: string[];
};

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
  btc: 'BTCUSD',
  bitcoin: 'BTCUSD',
  eth: 'ETHUSD',
  ethereum: 'ETHUSD'
};

function normalizeSymbol(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9.]/g, '');
}

function parseTickers(query: string): string[] {
  const normalized = query.toLowerCase();
  const found = new Set<string>();

  for (const [alias, symbol] of Object.entries(TICKER_ALIASES)) {
    if (normalized.includes(alias)) {
      found.add(symbol);
    }
  }

  const explicit = query.match(/\$?[A-Z]{1,6}(?:\.[A-Z]{1,2})?/g) ?? [];
  for (const token of explicit) {
    const cleaned = normalizeSymbol(token.replace('$', ''));
    if (cleaned && cleaned.length <= 8) {
      found.add(cleaned);
    }
  }

  return [...found].slice(0, Math.max(1, config.tools.openbbMaxSymbols));
}

function asNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(String(value).replace(/,/g, '').replace('%', '').trim());
  return Number.isFinite(n) ? n : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function formatNumber(value: number | undefined, maxFractionDigits = 2): string {
  if (value === undefined) return 'n/a';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: maxFractionDigits }).format(value);
}

function formatPercent(value: number | undefined): string {
  if (value === undefined) return 'n/a';
  return `${value.toFixed(2)}%`;
}

function toRecordArray(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) {
    return payload.filter((item): item is JsonRecord => typeof item === 'object' && item !== null);
  }

  if (typeof payload !== 'object' || payload === null) {
    return [];
  }

  const obj = payload as JsonRecord;
  const candidateKeys = ['results', 'data', 'items', 'content'];
  for (const key of candidateKeys) {
    const value = obj[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is JsonRecord => typeof item === 'object' && item !== null);
    }
  }

  return [obj];
}

function buildBaseUrl(): string | null {
  const raw = config.tools.openbbApiBaseUrl.trim();
  if (!raw) return null;

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

function buildAuthHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    accept: 'application/json'
  };

  if (config.tools.openbbAuthToken) {
    headers.authorization = `Bearer ${config.tools.openbbAuthToken}`;
    return headers;
  }

  if (config.tools.openbbUsername && config.tools.openbbPassword) {
    const encoded = Buffer.from(`${config.tools.openbbUsername}:${config.tools.openbbPassword}`).toString('base64');
    headers.authorization = `Basic ${encoded}`;
  }

  return headers;
}

async function openbbRequest(
  pathname: string,
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal
): Promise<OpenbbCallResult> {
  const baseUrl = buildBaseUrl();
  if (!baseUrl) {
    return {
      ok: false,
      status: 0,
      url: pathname,
      data: null,
      error: 'OPENBB_API_BASE_URL missing'
    };
  }

  const prefix = config.tools.openbbApiPrefix.startsWith('/')
    ? config.tools.openbbApiPrefix
    : `/${config.tools.openbbApiPrefix}`;
  const url = new URL(`${baseUrl}${prefix}${pathname}`);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  try {
    throwIfAborted(signal);

    const response = await fetch(url, {
      method: 'GET',
      headers: buildAuthHeaders(),
      signal: createTimeoutSignal(config.tools.openbbApiTimeoutMs, signal)
    });

    const responseText = await response.text();
    let parsed: unknown = responseText;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      // keep as text
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        url: url.toString(),
        data: parsed,
        error: `HTTP ${response.status}`
      };
    }

    return {
      ok: true,
      status: response.status,
      url: url.toString(),
      data: parsed
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      url: url.toString(),
      data: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function pickQuoteRecord(symbol: string, payload: unknown): JsonRecord | undefined {
  const records = toRecordArray(payload);
  if (records.length === 0) return undefined;

  const exact = records.find((record) => String(record.symbol ?? '').toUpperCase() === symbol.toUpperCase());
  return exact ?? records[0];
}

function buildQuoteSnapshot(record: JsonRecord | undefined): SymbolInsight['quote'] {
  if (!record) return undefined;

  return {
    price: asNumber(record.last_price ?? record.price ?? record.close),
    open: asNumber(record.open),
    high: asNumber(record.high),
    low: asNumber(record.low),
    volume: asNumber(record.volume),
    asOf: asString(record.date ?? record.timestamp ?? record.last_timestamp)
  };
}

function extractCloseSeries(payload: unknown): number[] {
  const records = toRecordArray(payload);
  const closes: number[] = [];

  for (const row of records) {
    const close = asNumber(row.close ?? row.adj_close ?? row.last_price ?? row.price);
    if (close !== undefined) {
      closes.push(close);
    }
  }

  return closes;
}

function computeTrend(closeSeries: number[]): SymbolInsight['trend'] {
  if (closeSeries.length < 2) {
    return {
      points: closeSeries.length,
      pct1d: undefined,
      pct5d: undefined
    };
  }

  const last = closeSeries[closeSeries.length - 1];
  const prev = closeSeries[closeSeries.length - 2];
  const prev5 = closeSeries[Math.max(0, closeSeries.length - 6)];

  const pct1d = prev > 0 ? ((last - prev) / prev) * 100 : undefined;
  const pct5d = prev5 > 0 ? ((last - prev5) / prev5) * 100 : undefined;

  return {
    points: closeSeries.length,
    pct1d,
    pct5d
  };
}

function extractNewsTitles(payload: unknown, max = 2): string[] {
  const records = toRecordArray(payload);
  const titles = records
    .map((row) => asString(row.title ?? row.headline ?? row.summary))
    .filter((value): value is string => Boolean(value));

  return [...new Set(titles)].slice(0, max);
}

async function collectSymbolInsight(symbol: string, signal?: AbortSignal): Promise<{ insight: SymbolInsight; citations: string[] }> {
  const provider = config.tools.openbbProvider;
  const newsProvider = config.tools.openbbNewsProvider;

  const [quoteResp, historicalResp, companyNewsResp] = await Promise.all([
    openbbRequest('/equity/price/quote', { symbol, provider }, signal),
    openbbRequest(
      '/equity/price/historical',
      {
        symbol,
        provider,
        interval: '1d',
        limit: config.tools.openbbHistoryLimit
      },
      signal
    ),
    openbbRequest(
      '/news/company',
      {
        symbol,
        provider: newsProvider,
        limit: config.tools.openbbNewsLimit
      },
      signal
    )
  ]);

  const citations = [quoteResp.url, historicalResp.url, companyNewsResp.url];
  const errors: string[] = [];

  if (!quoteResp.ok) {
    errors.push(`quote: ${quoteResp.error ?? 'failed'}`);
  }

  if (!historicalResp.ok) {
    errors.push(`historical: ${historicalResp.error ?? 'failed'}`);
  }

  if (!companyNewsResp.ok) {
    errors.push(`company_news: ${companyNewsResp.error ?? 'failed'}`);
  }

  const quoteRecord = pickQuoteRecord(symbol, quoteResp.data);
  const quote = buildQuoteSnapshot(quoteRecord);
  const trend = computeTrend(extractCloseSeries(historicalResp.data));
  const companyNewsTitles = extractNewsTitles(companyNewsResp.data, 2);

  return {
    insight: {
      symbol,
      quote,
      trend,
      companyNewsTitles,
      errors
    },
    citations
  };
}

function buildSymbolLine(item: SymbolInsight): string {
  const quote = item.quote;
  const trend = item.trend;

  const quotePart = quote
    ? `price=${formatNumber(quote.price)}, open=${formatNumber(quote.open)}, high=${formatNumber(quote.high)}, low=${formatNumber(quote.low)}, volume=${formatNumber(quote.volume, 0)}, asOf=${quote.asOf ?? 'n/a'}`
    : 'quote=n/a';

  const trendPart = trend
    ? `1d=${formatPercent(trend.pct1d)}, 5d=${formatPercent(trend.pct5d)}, candles=${trend.points}`
    : 'trend=n/a';

  const newsPart = item.companyNewsTitles.length
    ? `company_news=${item.companyNewsTitles.join(' | ')}`
    : 'company_news=n/a';

  const errorPart = item.errors.length ? `errors=${item.errors.join('; ')}` : 'errors=none';

  return `${item.symbol}: ${quotePart}; trend(${trendPart}); ${newsPart}; ${errorPart}`;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export const openbbSearchTool: ToolAdapter = {
  name: 'openbb_search',
  async execute(input: ToolInput): Promise<ToolResult> {
    if (!config.tools.openbbEnabled) {
      return {
        tool: 'openbb_search',
        summary: 'OpenBB tool devre dışı (OPENBB_ENABLED=false).',
        citations: [],
        raw: { enabled: false }
      };
    }

    if (!buildBaseUrl()) {
      return {
        tool: 'openbb_search',
        summary: 'OpenBB tool yapılandırılmamış: OPENBB_API_BASE_URL eksik.',
        citations: [],
        raw: { enabled: true, configured: false }
      };
    }

    const symbols = parseTickers(input.query);
    const lines: string[] = [];
    const citations: string[] = [];

    if (symbols.length === 0) {
      lines.push('Ticker tespit edilemedi; OpenBB world news + makro akış denenecek.');
    }

    const symbolInsights: SymbolInsight[] = [];
    for (const symbol of symbols) {
      throwIfAborted(input.signal);

      const { insight, citations: symbolCitations } = await collectSymbolInsight(symbol, input.signal);
      symbolInsights.push(insight);
      citations.push(...symbolCitations);
      lines.push(buildSymbolLine(insight));
    }

    throwIfAborted(input.signal);

    const worldNews = await openbbRequest(
      '/news/world',
      {
        provider: config.tools.openbbWorldNewsProvider,
        limit: config.tools.openbbNewsLimit
      },
      input.signal
    );
    citations.push(worldNews.url);

    if (worldNews.ok) {
      const worldTitles = extractNewsTitles(worldNews.data, 3);
      if (worldTitles.length > 0) {
        lines.push(`world_news=${worldTitles.join(' | ')}`);
      } else {
        lines.push('world_news=n/a');
      }
    } else {
      lines.push(`world_news error=${worldNews.error ?? 'failed'}`);
    }

    return {
      tool: 'openbb_search',
      summary: lines.join('\n'),
      citations: dedupe(citations).slice(0, 30),
      raw: {
        symbols,
        provider: config.tools.openbbProvider,
        newsProvider: config.tools.openbbNewsProvider,
        worldNewsProvider: config.tools.openbbWorldNewsProvider,
        symbolInsights
      }
    };
  }
};

export const __private__ = {
  parseTickers,
  toRecordArray,
  computeTrend,
  extractNewsTitles,
  buildQuoteSnapshot,
  asNumber
};
