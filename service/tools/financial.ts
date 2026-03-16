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
  meta: 'META'
};

function guessTicker(query: string): string | null {
  const normalized = query.toLowerCase();
  for (const [k, v] of Object.entries(TICKER_ALIASES)) {
    if (normalized.includes(k)) return v;
  }

  const match = query.match(/\b[A-Z]{1,5}\b/);
  return match?.[0] ?? null;
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

  return {
    symbol: cols[0],
    date: cols[1],
    time: cols[2],
    open: Number(cols[3]),
    high: Number(cols[4]),
    low: Number(cols[5]),
    close: Number(cols[6]),
    volume: Number(cols[7])
  };
}

export const financialDeepSearchTool: ToolAdapter = {
  name: 'financial_deep_search',
  async execute(input: ToolInput): Promise<ToolResult> {
    const ticker = guessTicker(input.query);

    const citations: string[] = [];
    const lines: string[] = [];

    if (ticker) {
      const stooqUrl = `https://stooq.com/q/l/?s=${ticker.toLowerCase()}.us&i=d`;
      citations.push(stooqUrl);

      try {
        const priceRes = await fetch(stooqUrl, { signal: AbortSignal.timeout(12_000) });
        if (priceRes.ok) {
          const csv = await priceRes.text();
          const quote = parseStooq(csv);
          if (quote) {
            lines.push(
              `${quote.symbol} son kapanış: ${quote.close} (open: ${quote.open}, high: ${quote.high}, low: ${quote.low}, volume: ${quote.volume}, date: ${quote.date})`
            );
          }
        }
      } catch {
        // fallback below
      }
    }

    const news = await webSearchTool.execute({ query: `${ticker ?? ''} stock news ${input.query}`.trim() });
    lines.push('Haber özeti:');
    lines.push(news.summary);
    citations.push(...news.citations);

    return {
      tool: 'financial_deep_search',
      summary: lines.join('\n'),
      citations,
      raw: { ticker: ticker ?? null }
    };
  }
};
