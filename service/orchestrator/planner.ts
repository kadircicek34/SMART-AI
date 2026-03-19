import type { Plan, PlanStage } from './types.js';
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

const OPENBB_KEYWORDS = [
  'openbb',
  'trading',
  'trade',
  'binance',
  'technical indicator',
  'teknik indikatör',
  'rsi',
  'macd',
  'bollinger',
  'candlestick',
  'ohlc',
  'company news',
  'macro data',
  'ekonomik veri'
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

const MEVZUAT_KEYWORDS = [
  'kanun',
  'mevzuat',
  'tebliğ',
  'teblig',
  'resmi gazete',
  'cumhurbaşkanlığı kararnamesi',
  'cbk',
  'khk',
  'tüzük',
  'yönetmelik',
  'hukuk metni'
];

const YARGI_KEYWORDS = [
  'yargıtay',
  'yargitay',
  'danıştay',
  'danistay',
  'emsal karar',
  'mahkeme kararı',
  'anayasa mahkemesi',
  'uyuşmazlık mahkemesi',
  'kik kararı',
  'sayıştay',
  'rekabet kurumu',
  'kvkk kararı',
  'bddk kararı',
  'sigorta tahkim'
];

const BORSA_MCP_KEYWORDS = [
  'bist',
  'xu100',
  'xbank',
  'tefas',
  'kap haberi',
  'fon',
  'garan',
  'akbnk',
  'thyao',
  'asels',
  'tüpraş',
  'tuprs'
];

function hasKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function buildStages(tools: ToolName[]): PlanStage[] {
  const stages: PlanStage[] = [];
  const addStage = (id: string, title: string, stageTools: ToolName[]) => {
    if (stageTools.length === 0) return;
    stages.push({ id, title, tools: stageTools, status: 'pending' });
  };

  addStage(
    'discover',
    'Keşif ve kaynak toplama',
    tools.filter((tool) => ['web_search', 'wikipedia', 'qmd_search', 'rag_search', 'memory_search'].includes(tool))
  );

  addStage(
    'domain',
    'Domain doğrulama',
    tools.filter((tool) => ['mevzuat_mcp_search', 'yargi_mcp_search', 'borsa_mcp_search', 'financial_deep_search', 'openbb_search'].includes(tool))
  );

  addStage('synthesis', 'Derin analiz ve sentez', tools.filter((tool) => ['deep_research'].includes(tool)));

  return stages.length > 0
    ? stages
    : [
        {
          id: 'direct',
          title: 'Doğrudan yanıt',
          tools: [],
          status: 'pending'
        }
      ];
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

function shouldUseMevzuatMcp(query: string): boolean {
  const normalized = query.toLowerCase();
  if (hasKeyword(normalized, MEVZUAT_KEYWORDS)) return true;

  return /(hukuk|mevzuat|kanun|resmi gazete)/i.test(query);
}

function shouldUseYargiMcp(query: string): boolean {
  const normalized = query.toLowerCase();
  if (hasKeyword(normalized, YARGI_KEYWORDS)) return true;

  return /(mahkeme|emsal|karar metni|yargı|yargi)/i.test(query);
}

function shouldUseBorsaMcp(query: string): boolean {
  const normalized = query.toLowerCase();
  if (hasKeyword(normalized, BORSA_MCP_KEYWORDS)) return true;

  return /(bist|tefas|kap|hisse kodu|ticker|endeks|borsa istanbul)/i.test(query);
}

function shouldUseOpenbb(query: string): boolean {
  const normalized = query.toLowerCase();
  if (hasKeyword(normalized, OPENBB_KEYWORDS)) return true;

  return /(ai trading|trading bot|algoritmik|teknik analiz|teknik indikat|market data|haber analizi|volatilite)/i.test(query);
}

export function planForQuery(query: string): Plan {
  const tools: ToolName[] = [];

  if (hasKeyword(query, FINANCIAL_KEYWORDS)) {
    tools.push('financial_deep_search');
  }

  if (shouldUseOpenbb(query)) {
    tools.push('openbb_search');
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

  if (shouldUseMevzuatMcp(query)) {
    tools.push('mevzuat_mcp_search');
  }

  if (shouldUseYargiMcp(query)) {
    tools.push('yargi_mcp_search');
  }

  if (shouldUseBorsaMcp(query)) {
    tools.push('borsa_mcp_search');
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
    reasoning: `Heuristic plan selected tools: ${normalizedTools.join(', ')}`,
    stages: buildStages(normalizedTools)
  };
}
