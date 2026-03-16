import type { Plan } from './types.js';
import type { ToolName } from '../tools/types.js';

const FINANCIAL_KEYWORDS = [
  'stock', 'finance', 'financial', 'earnings', 'revenue', 'balance sheet', 'cash flow',
  'hisse', 'finans', 'gelir', 'bilanço', 'nakit akış', 'borsa'
];

const WIKI_KEYWORDS = ['who is', 'what is', 'history', 'nedir', 'kimdir', 'tarihçe', 'wikipedia'];
const RESEARCH_KEYWORDS = ['deep', 'research', 'analyze', 'analysis', 'araştır', 'detay', 'karşılaştır'];

function hasKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export function planForQuery(query: string): Plan {
  const tools: ToolName[] = [];

  if (hasKeyword(query, FINANCIAL_KEYWORDS)) {
    tools.push('financial_deep_search');
  }

  if (hasKeyword(query, WIKI_KEYWORDS)) {
    tools.push('wikipedia');
  }

  if (hasKeyword(query, RESEARCH_KEYWORDS)) {
    tools.push('deep_research');
  }

  const qLen = query.trim().length;
  const isSmallTalk = /^(selam|merhaba|hi|hello|hey|nasılsın|naber)[!.?\s]*$/i.test(query.trim());

  if (!isSmallTalk && (qLen > 20 || tools.length === 0)) {
    tools.push('web_search');
  }

  const normalizedTools = dedupe(tools).slice(0, 4);

  return {
    objective: query,
    tools: normalizedTools,
    reasoning: `Heuristic plan selected tools: ${normalizedTools.join(', ')}`
  };
}
