import { config } from '../config.js';
import { chatWithOpenRouter, type LlmMessage } from '../llm/openrouter-client.js';
import type { ToolName } from '../tools/types.js';
import { createTimeoutSignal } from '../utils/abort.js';

export type IntentRouterTool =
  | 'direct_answer'
  | 'web_search'
  | 'mevzuat_rag'
  | 'yargi_mcp'
  | 'borsa_mcp'
  | 'openbb_search'
  | 'rag_knowledge'
  | 'qmd_search'
  | 'deep_reasoning';

export type IntentRouteResult = {
  semanticTools: IntentRouterTool[];
  planTools: ToolName[];
  confidence: number;
  reasoning: string;
};

const ALLOWED_INTENT_TOOLS: IntentRouterTool[] = [
  'direct_answer',
  'web_search',
  'mevzuat_rag',
  'yargi_mcp',
  'borsa_mcp',
  'openbb_search',
  'rag_knowledge',
  'qmd_search',
  'deep_reasoning'
];

const INTENT_ROUTER_SYSTEM_PROMPT = `Sen bir query router’sın. Kullanıcının sorusunu analiz et ve hangi kaynakların gerekli olduğuna karar ver. Sadece JSON döndür, başka hiçbir şey yazma.
Kaynaklar:
 ∙ direct_answer: Genel sohbet, selamlama, fikir sorma, yazım yardımı. Hukuki veya teknik bilgi gerektirmeyen sorular.
 ∙ web_search: Güncel bilgi, haberler, fiyatlar, son gelişmeler, tarih veya kişi hakkında güncel bilgi gerektiren sorular.
 ∙ mevzuat_rag: Türk hukuku, kanun, yönetmelik, tüzük, mevzuat bilgisi gerektiren sorular. Kullanıcı kanun kelimesini kullanmasa bile hukuki bir konuyu soruyorsa bu seçilmeli.
 ∙ yargi_mcp: Yargıtay kararları, içtihat, mahkeme kararları ile ilgili sorular.
 ∙ borsa_mcp: Borsa, hisse senedi, BIST, finansal piyasa verileri.
 ∙ openbb_search: Makroekonomik veriler, ekonomik göstergeler, şirket finansal verileri.
 ∙ rag_knowledge: İç dokümanlar, bilgi tabanı, proje dokümanları.
 ∙ qmd_search: SMART-AI projesinin kendi dokümanları, readme, task.md, prd.md.
 ∙ deep_reasoning: Karmaşık analiz, karşılaştırma, strateji, çok adımlı mantık gerektiren sorular.
Kurallar:
 ∙ Birden fazla kaynak seçebilirsin.
 ∙ Emin olmadığında direct_answer + en olası kaynağı birlikte seç.
 ∙ Hukuki terimler, iş hukuku, ceza hukuku, medeni hukuk gibi konular her zaman mevzuat_rag tetiklemeli.
Yanıt formatı: {"tools": ["direct_answer"], "confidence": 0.9, "reasoning": "tek cümle açıklama"}`;

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function stripCodeFences(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function extractJsonObject(value: string): string | null {
  const cleaned = stripCodeFences(value);
  if (!cleaned) {
    return null;
  }

  if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
    return cleaned;
  }

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }

  return cleaned.slice(start, end + 1);
}

function normalizeIntentTools(value: unknown): IntentRouterTool[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return dedupe(
    value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item): item is IntentRouterTool => ALLOWED_INTENT_TOOLS.includes(item as IntentRouterTool))
  );
}

function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0.5;
  }

  return Math.max(0, Math.min(1, value));
}

function normalizeReasoning(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    return 'Intent router olası en uygun yolu seçti.';
  }

  return value.trim().slice(0, 240);
}

function buildIntentRouterMessages(query: string): LlmMessage[] {
  return [
    {
      role: 'system',
      content: INTENT_ROUTER_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: `Kullanıcı sorusu:\n${query.trim()}`
    }
  ];
}

export function mapIntentToolsToPlanTools(tools: IntentRouterTool[]): ToolName[] {
  const mapped: ToolName[] = [];

  for (const tool of tools) {
    switch (tool) {
      case 'web_search':
        mapped.push('web_search');
        break;
      case 'mevzuat_rag':
        mapped.push('mevzuat_mcp_search');
        break;
      case 'yargi_mcp':
        mapped.push('yargi_mcp_search');
        break;
      case 'borsa_mcp':
        mapped.push('borsa_mcp_search');
        break;
      case 'openbb_search':
        mapped.push('openbb_search');
        break;
      case 'rag_knowledge':
        mapped.push('rag_search');
        break;
      case 'qmd_search':
        mapped.push('qmd_search');
        break;
      case 'direct_answer':
      case 'deep_reasoning':
        break;
    }
  }

  return dedupe(mapped);
}

export function parseIntentRouterContent(content: string): IntentRouteResult | null {
  const jsonText = extractJsonObject(content);
  if (!jsonText) {
    return null;
  }

  const parsed = JSON.parse(jsonText) as {
    tools?: unknown;
    confidence?: unknown;
    reasoning?: unknown;
  };

  const semanticTools = normalizeIntentTools(parsed.tools);
  if (semanticTools.length === 0) {
    return null;
  }

  return {
    semanticTools,
    planTools: mapIntentToolsToPlanTools(semanticTools),
    confidence: clampConfidence(parsed.confidence),
    reasoning: normalizeReasoning(parsed.reasoning)
  };
}

export async function routeIntent(params: {
  query: string;
  apiKey?: string;
  signal?: AbortSignal;
}): Promise<IntentRouteResult | null> {
  if (!params.apiKey?.trim()) {
    return null;
  }

  try {
    const completion = await chatWithOpenRouter({
      apiKey: params.apiKey,
      model: config.intentRouter.model,
      messages: buildIntentRouterMessages(params.query),
      temperature: config.intentRouter.temperature,
      maxTokens: config.intentRouter.maxTokens,
      reasoning: false,
      signal: createTimeoutSignal(config.intentRouter.timeoutMs, params.signal)
    });

    return parseIntentRouterContent(completion.text);
  } catch {
    return null;
  }
}

export const __private__ = {
  INTENT_ROUTER_SYSTEM_PROMPT,
  stripCodeFences,
  extractJsonObject,
  normalizeIntentTools,
  mapIntentToolsToPlanTools,
  buildIntentRouterMessages,
  parseIntentRouterContent
};
