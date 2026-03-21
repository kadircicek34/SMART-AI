import { createTimeoutSignal, throwIfAborted } from '../utils/abort.js';
import type { ToolAdapter, ToolInput, ToolResult } from './types.js';

type SearchResp = {
  query?: {
    search?: Array<{ pageid: number; title: string; snippet: string }>;
  };
};

type ExtractResp = {
  query?: {
    pages?: Record<string, { title?: string; extract?: string; fullurl?: string }>;
  };
};

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

export const wikipediaTool: ToolAdapter = {
  name: 'wikipedia',
  async execute(input: ToolInput): Promise<ToolResult> {
    const searchUrl = new URL('https://en.wikipedia.org/w/api.php');
    searchUrl.searchParams.set('action', 'query');
    searchUrl.searchParams.set('list', 'search');
    searchUrl.searchParams.set('format', 'json');
    searchUrl.searchParams.set('utf8', '1');
    searchUrl.searchParams.set('srlimit', '3');
    searchUrl.searchParams.set('srsearch', input.query);

    throwIfAborted(input.signal);
    const searchRes = await fetch(searchUrl, { signal: createTimeoutSignal(12_000, input.signal) });
    if (!searchRes.ok) {
      throw new Error(`wikipedia search failed (${searchRes.status})`);
    }

    const searchJson = (await searchRes.json()) as SearchResp;
    const hits = searchJson.query?.search ?? [];
    if (hits.length === 0) {
      return {
        tool: 'wikipedia',
        summary: 'Wikipedia üzerinde eşleşen sonuç bulunamadı.',
        citations: []
      };
    }

    const ids = hits.map((h) => h.pageid).join('|');
    const extractUrl = new URL('https://en.wikipedia.org/w/api.php');
    extractUrl.searchParams.set('action', 'query');
    extractUrl.searchParams.set('format', 'json');
    extractUrl.searchParams.set('prop', 'extracts|info');
    extractUrl.searchParams.set('pageids', ids);
    extractUrl.searchParams.set('inprop', 'url');
    extractUrl.searchParams.set('exintro', '1');
    extractUrl.searchParams.set('explaintext', '1');

    throwIfAborted(input.signal);
    const extractRes = await fetch(extractUrl, { signal: createTimeoutSignal(12_000, input.signal) });
    if (!extractRes.ok) {
      throw new Error(`wikipedia extract failed (${extractRes.status})`);
    }

    const extractJson = (await extractRes.json()) as ExtractResp;
    const pages = Object.values(extractJson.query?.pages ?? {});

    const lines: string[] = [];
    const citations: string[] = [];

    for (const page of pages.slice(0, 3)) {
      const title = page.title ?? 'Unknown';
      const extract = stripHtml((page.extract ?? '').slice(0, 600));
      lines.push(`- ${title}: ${extract || 'Özet yok'}`);
      if (page.fullurl) citations.push(page.fullurl);
    }

    return {
      tool: 'wikipedia',
      summary: lines.join('\n'),
      citations,
      raw: { hits: hits.map((h) => ({ title: h.title, snippet: stripHtml(h.snippet) })) }
    };
  }
};
