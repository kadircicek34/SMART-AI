import { config } from '../config.js';
import type { ToolAdapter, ToolInput, ToolResult } from './types.js';

type DuckResponse = {
  AbstractText?: string;
  AbstractURL?: string;
  RelatedTopics?: Array<{ Text?: string; FirstURL?: string } | { Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
  Results?: Array<{ Text?: string; FirstURL?: string }>;
};

type BraveResponse = {
  web?: {
    results?: Array<{ title?: string; url?: string; description?: string }>;
  };
};

function flattenTopics(resp: DuckResponse): Array<{ text: string; url?: string }> {
  const out: Array<{ text: string; url?: string }> = [];

  for (const item of resp.RelatedTopics ?? []) {
    if ('Topics' in item && Array.isArray(item.Topics)) {
      for (const sub of item.Topics) {
        if (sub.Text) out.push({ text: sub.Text, url: sub.FirstURL });
      }
      continue;
    }

    if ('Text' in item && item.Text) {
      out.push({ text: item.Text, url: item.FirstURL });
    }
  }

  for (const result of resp.Results ?? []) {
    if (result.Text) out.push({ text: result.Text, url: result.FirstURL });
  }

  return out;
}

async function runDuckDuckGo(query: string): Promise<ToolResult> {
  const url = new URL('https://api.duckduckgo.com/');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_redirect', '1');
  url.searchParams.set('no_html', '1');

  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) {
    throw new Error(`web_search failed (${res.status})`);
  }

  const json = (await res.json()) as DuckResponse;
  const snippets = flattenTopics(json).slice(0, 6);

  const lines: string[] = [];
  if (json.AbstractText) {
    lines.push(`Öne çıkan cevap: ${json.AbstractText}`);
  }

  for (const item of snippets) {
    lines.push(`- ${item.text}`);
  }

  if (lines.length === 0) {
    lines.push('Sorgu için yapılandırılmış web özeti bulunamadı.');
  }

  const citations = [json.AbstractURL, ...snippets.map((s) => s.url)].filter((v): v is string => Boolean(v));

  return {
    tool: 'web_search',
    summary: lines.join('\n'),
    citations,
    raw: { provider: 'duckduckgo', abstract: json.AbstractText, topics: snippets }
  };
}

async function runBrave(query: string, locale?: string): Promise<ToolResult> {
  const braveApiKey = config.tools.braveApiKey;
  if (!braveApiKey) {
    throw new Error('brave_api_key_missing');
  }

  const url = new URL(config.tools.braveApiBaseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('count', '6');
  url.searchParams.set('spellcheck', '1');

  if (locale) {
    const [language, country] = locale.split('-');
    if (language) url.searchParams.set('search_lang', language.toLowerCase());
    if (country) url.searchParams.set('country', country.toUpperCase());
  }

  const res = await fetch(url, {
    signal: AbortSignal.timeout(12_000),
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': braveApiKey
    }
  });

  if (!res.ok) {
    throw new Error(`brave_search_failed_${res.status}`);
  }

  const json = (await res.json()) as BraveResponse;
  const items = (json.web?.results ?? []).slice(0, 6);

  if (items.length === 0) {
    return {
      tool: 'web_search',
      summary: 'Brave aramasında sonuç bulunamadı.',
      citations: [],
      raw: {
        provider: 'brave',
        results: []
      }
    };
  }

  const lines = items.map((item) => {
    const title = item.title?.trim() || 'Untitled';
    const desc = item.description?.trim() || 'Özet yok';
    return `- ${title}: ${desc}`;
  });

  const citations = items.map((item) => item.url).filter((value): value is string => Boolean(value));

  return {
    tool: 'web_search',
    summary: lines.join('\n'),
    citations,
    raw: {
      provider: 'brave',
      results: items
    }
  };
}

export const webSearchTool: ToolAdapter = {
  name: 'web_search',
  async execute(input: ToolInput): Promise<ToolResult> {
    if (config.tools.braveApiKey) {
      try {
        return await runBrave(input.query, input.locale);
      } catch {
        // fall through to duckduckgo fallback
      }
    }

    return runDuckDuckGo(input.query);
  }
};
