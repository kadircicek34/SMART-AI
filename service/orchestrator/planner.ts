import type { Plan } from './types.js';
import type { ToolName } from '../tools/types.js';

const FINANCIAL_KEYWORDS = [
  'stock',
  'finance',
  'financial',
  'earnings',
  'revenue',
  'balance sheet',
  'cash flow',
  'hisse',
  'finans',
  'gelir',
  'bilanço',
  'nakit akış',
  'borsa'
];

const WIKI_KEYWORDS = ['who is', 'what is', 'history', 'nedir', 'kimdir', 'tarihçe', 'wikipedia'];
const RESEARCH_KEYWORDS = ['deep', 'research', 'analyze', 'analysis', 'araştır', 'detay', 'karşılaştır'];
const RAG_KEYWORDS = [
  'docs',
  'documentation',
  'knowledge base',
  'kb',
  'rag',
  'readme',
  'api spec',
  'contract',
  'repo',
  'codebase',
  'doküman',
  'döküman',
  'bilgi tabanı',
  'projede',
  'internal'
];

const MEMORY_KEYWORDS = [
  'remember',
  'recall',
  'memory',
  'previous',
  'past',
  'before',
  'history',
  'my preference',
  'about me',
  'hatırla',
  'hafıza',
  'önceki',
  'geçmiş',
  'benim tercihim',
  'hakkımda',
  'alışkanlığım'
];

const QMD_KEYWORDS = [
  'smart-ai',
  'project docs',
  'repo içinde',
  'codebase',
  'mimari',
  'task.md',
  'prd.md',
  'decisions.md',
  'state.json',
  'delivery.md',
  'roadmap',
  'runbook',
  'hangi endpoint',
  'bu projede',
  'local docs'
];

function hasKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function shouldUseRag(query: string): boolean {
  const normalized = query.toLowerCase();
  if (hasKeyword(normalized, RAG_KEYWORDS)) return true;

  return /(bizim|internal|tenant|dok[uü]man|repo|code|sözleşme|spec)/i.test(query) && /\?/i.test(query);
}

function shouldUseMemory(query: string): boolean {
  const normalized = query.toLowerCase();
  if (hasKeyword(normalized, MEMORY_KEYWORDS)) return true;

  return /(benim|hakkımda|tercih|alışkanlık|geçen|önceki|hatırlıyor|profilim|hafıza)/i.test(query);
}

function shouldUseQmd(query: string): boolean {
  const normalized = query.toLowerCase();
  if (hasKeyword(normalized, QMD_KEYWORDS)) return true;

  return /(projede|repository|repo|dok[üu]man|readme|roadmap|tasarım|architecture|endpoint|contract)/i.test(query);
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

  if (shouldUseRag(query)) {
    tools.push('rag_search');
  }

  if (shouldUseMemory(query)) {
    tools.push('memory_search');
  }

  if (shouldUseQmd(query)) {
    tools.push('qmd_search');
  }

  const qLen = query.trim().length;
  const isSmallTalk = /^(selam|merhaba|hi|hello|hey|nasılsın|naber)[!.?\s]*$/i.test(query.trim());

  if (!isSmallTalk && (qLen > 20 || tools.length === 0)) {
    tools.push('web_search');
  }

  const normalizedTools = dedupe(tools).slice(0, 5);

  return {
    objective: query,
    tools: normalizedTools,
    reasoning: `Heuristic plan selected tools: ${normalizedTools.join(', ')}`
  };
}
