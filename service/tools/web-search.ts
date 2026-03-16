import type { ToolAdapter, ToolInput, ToolResult } from './types.js';

type DuckResponse = {
  AbstractText?: string;
  AbstractURL?: string;
  RelatedTopics?: Array<{ Text?: string; FirstURL?: string } | { Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
  Results?: Array<{ Text?: string; FirstURL?: string }>;
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

export const webSearchTool: ToolAdapter = {
  name: 'web_search',
  async execute(input: ToolInput): Promise<ToolResult> {
    const url = new URL('https://api.duckduckgo.com/');
    url.searchParams.set('q', input.query);
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
      raw: { abstract: json.AbstractText, topics: snippets }
    };
  }
};
