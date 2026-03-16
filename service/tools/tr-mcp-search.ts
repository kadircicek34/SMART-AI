import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { canCallMcp, getMcpAdaptiveTimeout, recordMcpFailure, recordMcpSuccess } from '../mcp-health/index.js';
import type { ToolAdapter, ToolInput, ToolResult } from './types.js';
import type { McpServerId } from '../mcp-health/types.js';

const execFileAsync = promisify(execFile);

type McpRunnerResult = {
  stdout: string;
  stderr: string;
};

type McpRunner = (args: string[]) => Promise<McpRunnerResult>;

type JsonObject = Record<string, unknown>;

type MevzuatDocument = {
  mevzuat_no?: string;
  mev_adi?: string;
  resmi_gazete_tarihi?: string;
  resmi_gazete_sayisi?: string;
  url?: string;
};

type EmsalDecision = {
  id?: string;
  daire?: string;
  esasNo?: string;
  kararNo?: string;
  kararTarihi?: string;
  document_url?: string;
};

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function truncate(value: string, maxChars = 320): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function defaultRunner(args: string[]): Promise<McpRunnerResult> {
  return execFileAsync(config.tools.mcporterCommand, args, {
    timeout: config.tools.mcporterTimeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf-8'
  }).then(({ stdout, stderr }) => ({
    stdout: stdout ?? '',
    stderr: stderr ?? ''
  }));
}

function parseJsonIfPossible(raw: string): unknown {
  const text = raw.trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parsePseudoError(raw: string): string | null {
  // Handles mcporter's non-JSON inspect-like output:
  // { content: [ { type: 'text', text: '...' } ], isError: true }
  const textMatch = raw.match(/text:\s*'([\s\S]*?)'\s*\}?/m);
  if (!textMatch) return null;

  const extracted = textMatch[1]
    .replace(/\\n/g, '\n')
    .replace(/\s+\+\s*$/gm, '')
    .replace(/\s*'\s*\+\s*'/g, '')
    .trim();

  return extracted || null;
}

async function callMcpTool(
  runner: McpRunner,
  params: {
    serverUrl: string;
    toolName: string;
    args: JsonObject;
  },
  serverId: McpServerId
): Promise<{
  ok: boolean;
  parsed: unknown;
  error?: string;
  raw: string;
  stderr: string;
  circuitOpen?: boolean;
}> {
  if (!canCallMcp(serverId)) {
    return {
      ok: false,
      parsed: null,
      error: `MCP sunucusu "${serverId}" şu anda devre dışı (circuit open). Lütfen daha sonra tekrar deneyin.`,
      raw: '',
      stderr: '',
      circuitOpen: true
    };
  }

  const adaptiveTimeout = getMcpAdaptiveTimeout(serverId);
  const callArgs = [
    'call',
    `${params.serverUrl}.${params.toolName}`,
    '--timeout',
    String(Math.min(adaptiveTimeout, config.tools.mcporterTimeoutMs)),
    '--args',
    JSON.stringify(params.args),
    '--output',
    'json'
  ];

  const startTime = Date.now();

  try {
    const { stdout, stderr } = await runner(callArgs);
    const latencyMs = Date.now() - startTime;
    const parsed = parseJsonIfPossible(stdout);

    if (parsed && typeof parsed === 'object' && parsed !== null) {
      const maybeError = (parsed as JsonObject).error;
      if (typeof maybeError === 'string' && maybeError.trim()) {
        recordMcpFailure(serverId, maybeError, latencyMs);
        return {
          ok: false,
          parsed,
          error: maybeError,
          raw: stdout,
          stderr
        };
      }

      recordMcpSuccess(serverId, latencyMs);
      return {
        ok: true,
        parsed,
        raw: stdout,
        stderr
      };
    }

    const pseudoError = parsePseudoError(stdout);
    if (pseudoError) {
      recordMcpFailure(serverId, pseudoError, latencyMs);
      return {
        ok: false,
        parsed,
        error: pseudoError,
        raw: stdout,
        stderr
      };
    }

    const parseError = `MCP yanıtı parse edilemedi: ${truncate(stdout || stderr || 'empty response', 400)}`;
    recordMcpFailure(serverId, parseError, latencyMs);
    return {
      ok: false,
      parsed,
      error: parseError,
      raw: stdout,
      stderr
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    const errorMessage = toMessage(error);
    recordMcpFailure(serverId, errorMessage, latencyMs);
    return {
      ok: false,
      parsed: null,
      error: errorMessage,
      raw: '',
      stderr: ''
    };
  }
}

function marketFromQuery(query: string): 'bist' | 'us' | 'fund' | 'crypto_tr' | 'crypto_global' {
  const q = query.toLowerCase();

  if (/\b(fon|tefas|yatırım fonu|emeklilik fonu)\b/i.test(query)) {
    return 'fund';
  }

  if (/\b(crypto|kripto|btc|eth|usdt|coin)\b/i.test(query)) {
    return 'crypto_tr';
  }

  if (/\b(nasdaq|nyse|sp500|s&p|dow|aapl|msft|nvda|tsla|amzn|meta|googl)\b/i.test(query)) {
    return 'us';
  }

  if (/\b(global crypto|coinbase)\b/i.test(query)) {
    return 'crypto_global';
  }

  if (/\b(bist|xu100|xbank|garan|akbnk|thyao|asels|kchol|sise|tuprs)\b/i.test(query)) {
    return 'bist';
  }

  if (q.includes('hisse') || q.includes('borsa') || q.includes('endeks')) {
    return 'bist';
  }

  return 'bist';
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function makeCitation(base: string, pathOrUrl?: string): string {
  if (!pathOrUrl) return base;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `https://www.mevzuat.gov.tr/${pathOrUrl.replace(/^\//, '')}`;
}

async function executeMevzuatMcpSearch(
  input: ToolInput,
  runner: McpRunner
): Promise<ToolResult> {
  const query = input.query.trim();
  const toolName = /\b(tebliğ|teblig)\b/i.test(query) ? 'search_teblig' : 'search_kanun';
  const serverId: McpServerId = 'mevzuat';

  const call = await callMcpTool(
    runner,
    {
      serverUrl: config.tools.mevzuatMcpUrl,
      toolName,
      args: {
        aranacak_ifade: query,
        page_size: config.tools.mcpMaxResults
      }
    },
    serverId
  );

  if (call.circuitOpen) {
    return {
      tool: 'mevzuat_mcp_search',
      summary: call.error ?? 'Mevzuat MCP devre dışı',
      citations: [config.tools.mevzuatMcpUrl],
      raw: { circuitOpen: true, serverId }
    };
  }

  if (!call.ok || !call.parsed || typeof call.parsed !== 'object') {
    return {
      tool: 'mevzuat_mcp_search',
      summary: `mevzuat-mcp hatası: ${call.error ?? 'unknown error'}`,
      citations: [config.tools.mevzuatMcpUrl],
      raw: {
        error: call.error,
        stderr: call.stderr,
        raw: truncate(call.raw, 1200)
      }
    };
  }

  const parsed = call.parsed as JsonObject;
  const documents = asArray<MevzuatDocument>(parsed.documents).slice(0, config.tools.mcpMaxResults);
  if (documents.length === 0) {
    return {
      tool: 'mevzuat_mcp_search',
      summary: 'Mevzuat MCP üzerinde eşleşen kayıt bulunamadı.',
      citations: [config.tools.mevzuatMcpUrl],
      raw: parsed
    };
  }

  const lines = documents.map((doc, index) => {
    const no = doc.mevzuat_no ?? 'N/A';
    const title = doc.mev_adi ?? 'Başlık yok';
    const rg = [doc.resmi_gazete_tarihi, doc.resmi_gazete_sayisi].filter(Boolean).join(' / ');
    return `${index + 1}. ${no} — ${title}${rg ? ` (RG: ${rg})` : ''}`;
  });

  const citations = [
    ...new Set([
      config.tools.mevzuatMcpUrl,
      ...documents.map((doc) => makeCitation(config.tools.mevzuatMcpUrl, doc.url))
    ])
  ];

  return {
    tool: 'mevzuat_mcp_search',
    summary: lines.join('\n'),
    citations,
    raw: {
      toolName,
      total_results: parsed.total_results,
      documents
    }
  };
}

async function executeBorsaMcpSearch(
  input: ToolInput,
  runner: McpRunner
): Promise<ToolResult> {
  const query = input.query.trim();
  const market = marketFromQuery(query);
  const serverId: McpServerId = 'borsa';

  const searchCall = await callMcpTool(
    runner,
    {
      serverUrl: config.tools.borsaMcpUrl,
      toolName: 'search_symbol',
      args: {
        query,
        market,
        limit: config.tools.mcpMaxResults
      }
    },
    serverId
  );

  if (searchCall.circuitOpen) {
    return {
      tool: 'borsa_mcp_search',
      summary: searchCall.error ?? 'Borsa MCP devre dışı',
      citations: [config.tools.borsaMcpUrl],
      raw: { circuitOpen: true, serverId }
    };
  }

  if (!searchCall.ok || !searchCall.parsed || typeof searchCall.parsed !== 'object') {
    return {
      tool: 'borsa_mcp_search',
      summary: `borsa-mcp hatası: ${searchCall.error ?? 'unknown error'}`,
      citations: [config.tools.borsaMcpUrl],
      raw: {
        error: searchCall.error,
        stderr: searchCall.stderr,
        raw: truncate(searchCall.raw, 1200)
      }
    };
  }

  const parsed = searchCall.parsed as JsonObject;
  const matches = asArray<Record<string, unknown>>(parsed.matches).slice(0, config.tools.mcpMaxResults);

  if (matches.length === 0) {
    return {
      tool: 'borsa_mcp_search',
      summary: `Borsa MCP (${market}) aramasında eşleşme bulunamadı.`,
      citations: [config.tools.borsaMcpUrl],
      raw: parsed
    };
  }

  const topSymbol = String(matches[0]?.symbol ?? '').trim();
  let profileSummary = '';
  let profileRaw: unknown = null;

  if (topSymbol && ['bist', 'us', 'fund'].includes(market)) {
    const profileCall = await callMcpTool(
      runner,
      {
        serverUrl: config.tools.borsaMcpUrl,
        toolName: 'get_profile',
        args: {
          symbol: topSymbol,
          market
        }
      },
      serverId
    );

    if (profileCall.ok && profileCall.parsed && typeof profileCall.parsed === 'object') {
      profileRaw = profileCall.parsed;
      const profile = (profileCall.parsed as JsonObject).profile as JsonObject | undefined;
      if (profile) {
        const pe = profile.pe_ratio ?? 'n/a';
        const marketCap = profile.market_cap ?? 'n/a';
        const exchange = profile.exchange ?? 'n/a';
        profileSummary = `\nProfil (${topSymbol}): borsa=${exchange}, PE=${pe}, market_cap=${marketCap}`;
      }
    }
  }

  const lines = matches.map((match, index) => {
    const symbol = String(match.symbol ?? 'N/A');
    const name = String(match.name ?? 'N/A');
    const exchange = String(match.exchange ?? match.market ?? market);
    return `${index + 1}. ${symbol} — ${name} (${exchange})`;
  });

  return {
    tool: 'borsa_mcp_search',
    summary: lines.join('\n') + profileSummary,
    citations: [config.tools.borsaMcpUrl],
    raw: {
      market,
      matches,
      profile: profileRaw
    }
  };
}

async function executeYargiMcpSearch(
  input: ToolInput,
  runner: McpRunner
): Promise<ToolResult> {
  const query = input.query.trim();
  const serverId: McpServerId = 'yargi';

  const primaryCall = await callMcpTool(
    runner,
    {
      serverUrl: config.tools.yargiMcpUrl,
      toolName: 'search_emsal_detailed_decisions',
      args: {
        keyword: query,
        page_number: 1
      }
    },
    serverId
  );

  let parsed: JsonObject | null = null;
  let toolUsed = 'search_emsal_detailed_decisions';

  if (primaryCall.ok && primaryCall.parsed && typeof primaryCall.parsed === 'object') {
    parsed = primaryCall.parsed as JsonObject;
  }

  const primaryDecisions = parsed ? asArray<EmsalDecision>(parsed.decisions) : [];

  if ((!parsed || primaryDecisions.length === 0) && config.tools.yargiMcpFallbackEnabled) {
    const fallbackCall = await callMcpTool(
      runner,
      {
        serverUrl: config.tools.yargiMcpUrl,
        toolName: 'search_bedesten_unified',
        args: {
          phrase: query,
          pageNumber: 1
        }
      },
      serverId
    );

    if (fallbackCall.ok && fallbackCall.parsed && typeof fallbackCall.parsed === 'object') {
      parsed = fallbackCall.parsed as JsonObject;
      toolUsed = 'search_bedesten_unified';
    } else if (!parsed) {
      return {
        tool: 'yargi_mcp_search',
        summary: `yargi-mcp hatası: ${fallbackCall.error ?? primaryCall.error ?? 'unknown error'}`,
        citations: [config.tools.yargiMcpUrl],
        raw: {
          primary_error: primaryCall.error,
          fallback_error: fallbackCall.error,
          primary_raw: truncate(primaryCall.raw, 1000),
          fallback_raw: truncate(fallbackCall.raw, 1000)
        }
      };
    }
  }

  if (primaryCall.circuitOpen) {
    return {
      tool: 'yargi_mcp_search',
      summary: primaryCall.error ?? 'Yargı MCP devre dışı',
      citations: [config.tools.yargiMcpUrl],
      raw: { circuitOpen: true, serverId }
    };
  }

  if (!parsed) {
    return {
      tool: 'yargi_mcp_search',
      summary: `yargi-mcp hatası: ${primaryCall.error ?? 'unknown error'}`,
      citations: [config.tools.yargiMcpUrl],
      raw: {
        error: primaryCall.error,
        raw: truncate(primaryCall.raw, 1000)
      }
    };
  }

  const decisions = asArray<EmsalDecision>(parsed.decisions).slice(0, config.tools.mcpMaxResults);
  if (decisions.length === 0) {
    return {
      tool: 'yargi_mcp_search',
      summary: 'Yargı MCP aramasında eşleşen karar bulunamadı.',
      citations: [config.tools.yargiMcpUrl],
      raw: {
        toolUsed,
        parsed
      }
    };
  }

  const lines = decisions.map((decision, index) => {
    const daire = decision.daire ?? 'Daire bilgisi yok';
    const esas = decision.esasNo ? `E:${decision.esasNo}` : '';
    const karar = decision.kararNo ? `K:${decision.kararNo}` : '';
    const tarih = decision.kararTarihi ?? '';
    return `${index + 1}. ${daire}${tarih ? ` (${tarih})` : ''}${esas || karar ? ` ${[esas, karar].filter(Boolean).join(' ')}` : ''}`;
  });

  const citations = [
    ...new Set([
      config.tools.yargiMcpUrl,
      ...decisions.map((d) => d.document_url).filter((v): v is string => Boolean(v))
    ])
  ];

  return {
    tool: 'yargi_mcp_search',
    summary: lines.join('\n'),
    citations,
    raw: {
      toolUsed,
      total_records: parsed.total_records,
      decisions
    }
  };
}

export const mevzuatMcpSearchTool: ToolAdapter = {
  name: 'mevzuat_mcp_search',
  execute(input) {
    return executeMevzuatMcpSearch(input, defaultRunner);
  }
};

export const borsaMcpSearchTool: ToolAdapter = {
  name: 'borsa_mcp_search',
  execute(input) {
    return executeBorsaMcpSearch(input, defaultRunner);
  }
};

export const yargiMcpSearchTool: ToolAdapter = {
  name: 'yargi_mcp_search',
  execute(input) {
    return executeYargiMcpSearch(input, defaultRunner);
  }
};

export const __private__ = {
  callMcpTool,
  parseJsonIfPossible,
  parsePseudoError,
  marketFromQuery,
  executeMevzuatMcpSearch,
  executeBorsaMcpSearch,
  executeYargiMcpSearch
};
