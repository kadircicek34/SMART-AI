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
const RESEARCH_KEYWORDS = ['deep', 'research', 'analyze', 'analysis', 'araştır', 'detay', 'karşılaştır', 'incele'];
const STRATEGY_KEYWORDS = [
  'strategy',
  'strateji',
  'trade-off',
  'tasarım',
  'architecture',
  'mimari',
  'adım adım plan',
  'roadmap',
  'yaklaşım'
];
const WEB_RESEARCH_KEYWORDS = [
  'web search',
  'internetten',
  'webde',
  'kaynak',
  'source',
  'sources',
  'referans',
  'citation',
  'citations',
  'link',
  'haber',
  'news',
  'güncel',
  'latest',
  'current',
  'today',
  'bugün',
  'son durum',
  'recent',
  'release notes',
  'changelog'
];
const RAG_KEYWORDS = [
  'docs',
  'documentation',
  'knowledge base',
  'kb',
  'rag',
  'doküman',
  'döküman',
  'bilgi tabanı',
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
  'task.md',
  'prd.md',
  'decisions.md',
  'state.json',
  'delivery.md',
  'roadmap',
  'runbook',
  'hangi endpoint',
  'bu projede',
  'local docs',
  'readme'
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
  'hukuk metni',
  'iş sözleşmesi',
  'iş akdi',
  'fesih',
  'kıdem tazminatı',
  'ihbar tazminatı',
  'iş hukuku',
  'ceza hukuku',
  'medeni hukuk',
  'borçlar hukuku'
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
  'sigorta tahkim',
  'içtihat',
  'ictihat',
  'aym',
  'bireysel başvuru',
  'kira uyuşmazlığı',
  'kira uyuşmazlıkları'
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

function normalizeText(value: string): string {
  return value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/ı/g, 'i');
}

function hasKeyword(text: string, keywords: string[]): boolean {
  const normalizedText = normalizeText(text);
  return keywords.some((keyword) => normalizedText.includes(normalizeText(keyword)));
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

export function buildPlanFromTools(objective: string, tools: ToolName[], reasoning?: string): Plan {
  const uniqueTools = dedupe(tools);
  const maxTools = uniqueTools.includes('deep_research') ? 6 : 5;
  const normalizedTools = uniqueTools.slice(0, maxTools);

  return {
    objective,
    tools: normalizedTools,
    reasoning:
      reasoning ??
      (normalizedTools.length > 0
        ? `Planner selected tools: ${normalizedTools.join(', ')}`
        : 'Direct answer plan selected: no external evidence required.'),
    stages: buildStages(normalizedTools)
  };
}

function shouldUseRag(query: string): boolean {
  const normalized = query.toLowerCase();
  if (hasKeyword(normalized, RAG_KEYWORDS)) return true;

  return /(bizim|internal|tenant|dok[uü]man|bilgi taban[ıi]|rag)/i.test(query) && /\?/i.test(query);
}

function shouldUseMemory(query: string): boolean {
  const normalized = query.toLowerCase();
  if (hasKeyword(normalized, MEMORY_KEYWORDS)) return true;

  return /(benim|hakkımda|tercih|alışkanlık|geçen|önceki|hatırlıyor|profilim|hafıza)/i.test(query);
}

function shouldUseQmd(query: string): boolean {
  const normalized = query.toLowerCase();
  if (hasKeyword(normalized, QMD_KEYWORDS)) return true;

  return /(projede|repository|repo içinde|dok[üu]man|readme|roadmap|endpoint|contract|task\.md|prd\.md|decisions\.md|delivery\.md)/i.test(query);
}

function shouldUseMevzuatMcp(query: string): boolean {
  const normalized = query.toLowerCase();
  if (hasKeyword(normalized, MEVZUAT_KEYWORDS)) return true;

  return /(hukuk|mevzuat|kanun|resmi gazete|iş sözleşmesi|iş akdi|fesih|kıdem tazminatı|ihbar tazminatı|iş hukuku|ceza hukuku|medeni hukuk|borçlar hukuku)/i.test(
    query
  );
}

function shouldUseYargiMcp(query: string): boolean {
  const normalized = query.toLowerCase();
  if (hasKeyword(normalized, YARGI_KEYWORDS)) return true;

  return /(mahkeme|emsal|karar metni|yargı|yargi|içtihat|ictihat|anayasa mahkemesi|aym|bireysel başvuru)/i.test(query);
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

function shouldUseDeepReasoning(query: string): boolean {
  const normalized = query.toLowerCase();
  if (hasKeyword(normalized, STRATEGY_KEYWORDS) || hasKeyword(normalized, RESEARCH_KEYWORDS)) return true;

  const asksComparison = /(karşılaştır|compare|trade.?off|artı|eksi|alternatif)/i.test(query);
  const asksDeepAnalysis = /(detaylı analiz|deep research|derin analiz|değerlendir|tasarla|incele|design an approach)/i.test(query);
  return asksComparison || asksDeepAnalysis;
}

export function queryNeedsBroadEvidence(query: string): boolean {
  const normalized = query.toLowerCase();

  return (
    hasKeyword(normalized, RESEARCH_KEYWORDS) ||
    hasKeyword(normalized, WEB_RESEARCH_KEYWORDS) ||
    /(güncel|latest|current|today|bugün|şu an|recent|son durum|haber|news|kaynak|source|referans|citation|doğrula|verify|cross-check)/i.test(
      query
    ) ||
    shouldUseMevzuatMcp(query) ||
    shouldUseYargiMcp(query) ||
    shouldUseBorsaMcp(query) ||
    shouldUseOpenbb(query) ||
    shouldUseRag(query) ||
    shouldUseQmd(query) ||
    shouldUseMemory(query)
  );
}

export function shouldUseWebSearch(query: string, currentTools: ToolName[] = []): boolean {
  const normalized = query.toLowerCase();

  if (hasKeyword(normalized, WEB_RESEARCH_KEYWORDS)) return true;
  if (/https?:\/\//i.test(query)) return true;

  if (/(güncel|latest|current|today|bugün|şu an|recent|son durum|haber|news|release|changelog|istatistik|dataset|veri seti)/i.test(query)) {
    return true;
  }

  if (
    currentTools.some((tool) =>
      ['financial_deep_search', 'openbb_search', 'mevzuat_mcp_search', 'yargi_mcp_search', 'borsa_mcp_search'].includes(tool)
    ) && /(kaynak|source|referans|citation|doğrula|verify|karşılaştır|cross-check)/i.test(query)
  ) {
    return true;
  }

  return false;
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

  if (hasKeyword(query, RESEARCH_KEYWORDS) || shouldUseDeepReasoning(query)) {
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

  const isSmallTalk = /^(selam|merhaba|hi|hello|hey|nasılsın|naber)[!.?\s]*$/i.test(query.trim());

  if (!isSmallTalk && shouldUseWebSearch(query, tools)) {
    tools.push('web_search');
  }

  const maxTools = shouldUseDeepReasoning(query) ? 6 : 5;
  const normalizedTools = dedupe(tools).slice(0, maxTools);

  return buildPlanFromTools(
    query,
    normalizedTools,
    normalizedTools.length > 0 ? `Poetiq-plan selected tools: ${normalizedTools.join(', ')}` : 'Direct answer plan selected: no external evidence required.'
  );
}
