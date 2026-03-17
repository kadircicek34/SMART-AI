import crypto from 'node:crypto';
import path from 'node:path';

const parseCsv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

function getMasterKey(): Buffer {
  const raw = process.env.MASTER_KEY_BASE64;
  if (raw) {
    try {
      const decoded = Buffer.from(raw, 'base64');
      if (decoded.length >= 32) {
        return decoded.subarray(0, 32);
      }
    } catch {
      // fallthrough
    }
  }

  // deterministic fallback for local dev only
  return crypto.createHash('sha256').update('dev-master-key-change-me').digest();
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  isProd: (process.env.NODE_ENV ?? 'development') === 'production',
  port: Number(process.env.PORT ?? 8080),
  appApiKeys: parseCsv(process.env.APP_API_KEYS),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? 45_000),
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 60),
  maxSteps: Number(process.env.MAX_STEPS ?? 6),
  maxToolCalls: Number(process.env.MAX_TOOL_CALLS ?? 6),
  orchestrator: {
    maxToolPasses: Number(process.env.ORCHESTRATOR_MAX_TOOL_PASSES ?? 4),
    maxRepeatedToolPasses: Number(process.env.ORCHESTRATOR_MAX_REPEATED_TOOL_PASSES ?? 2)
  },
  verifier: {
    minCitations: Number(process.env.VERIFIER_MIN_CITATIONS ?? 2),
    minSourceDomains: Number(process.env.VERIFIER_MIN_SOURCE_DOMAINS ?? 2)
  },
  research: {
    maxQueries: Number(process.env.RESEARCH_MAX_QUERIES ?? 3),
    maxConcurrentUnits: Number(process.env.RESEARCH_MAX_CONCURRENT_UNITS ?? 2)
  },
  openRouter: {
    baseUrl: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
    defaultModel: process.env.OPENROUTER_DEFAULT_MODEL ?? 'deepseek/deepseek-chat-v3.1',
    globalApiKey: process.env.OPENROUTER_API_KEY,
    maxRetries: Number(process.env.OPENROUTER_MAX_RETRIES ?? 2),
    retryBaseDelayMs: Number(process.env.OPENROUTER_RETRY_BASE_DELAY_MS ?? 400),
    retryMaxDelayMs: Number(process.env.OPENROUTER_RETRY_MAX_DELAY_MS ?? 4_000)
  },
  tools: {
    exaApiKey: process.env.EXA_API_KEY,
    financialDatasetsApiKey: process.env.FINANCIAL_DATASETS_API_KEY,
    alphaVantageApiKey: process.env.ALPHA_VANTAGE_API_KEY,
    braveApiKey: process.env.BRAVE_API_KEY,
    braveApiBaseUrl: process.env.BRAVE_API_BASE_URL ?? 'https://api.search.brave.com/res/v1/web/search',
    qmdEnabled: (process.env.QMD_ENABLED ?? 'true').toLowerCase() === 'true',
    qmdCommand: process.env.QMD_COMMAND ?? 'qmd',
    qmdTimeoutMs: Number(process.env.QMD_TIMEOUT_MS ?? 15_000),
    qmdCollectionName: process.env.QMD_COLLECTION_NAME?.trim() || 'SMART-AI',
    qmdCollectionPath: process.env.QMD_COLLECTION_PATH?.trim() || path.resolve(process.cwd(), '..'),
    qmdCollectionAutoAdd: (process.env.QMD_COLLECTION_AUTO_ADD ?? 'true').toLowerCase() === 'true',
    qmdMaxResults: Number(process.env.QMD_MAX_RESULTS ?? 6),
    qmdMaxSnippetChars: Number(process.env.QMD_MAX_SNIPPET_CHARS ?? 260),
    mcporterCommand: process.env.MCPORTER_COMMAND ?? 'mcporter',
    mcporterTimeoutMs: Number(process.env.MCPORTER_TIMEOUT_MS ?? 45_000),
    mcpMaxResults: Number(process.env.MCP_MAX_RESULTS ?? 6),
    mevzuatMcpUrl: process.env.MEVZUAT_MCP_URL ?? 'https://mevzuat.surucu.dev/mcp',
    borsaMcpUrl: process.env.BORSA_MCP_URL ?? 'https://borsamcp.fastmcp.app/mcp',
    yargiMcpUrl: process.env.YARGI_MCP_URL ?? 'https://yargimcp.fastmcp.app/mcp',
    yargiMcpFallbackEnabled: (process.env.YARGI_MCP_FALLBACK_ENABLED ?? 'true').toLowerCase() === 'true'
  },
  storage: {
    root: process.env.DATA_DIR ?? path.resolve(process.cwd(), '.data'),
    keyStoreFile: process.env.KEY_STORE_FILE ?? path.resolve(process.cwd(), '.data', 'tenant-keys.json')
  },
  rag: {
    storeFile: process.env.RAG_STORE_FILE ?? path.resolve(process.cwd(), '.data', 'rag-store.json'),
    defaultChunkSize: Number(process.env.RAG_DEFAULT_CHUNK_SIZE ?? 1_200),
    defaultChunkOverlap: Number(process.env.RAG_DEFAULT_CHUNK_OVERLAP ?? 180)
  },
  memory: {
    storeFile: process.env.MEMORY_STORE_FILE ?? path.resolve(process.cwd(), '.data', 'memory-store.json'),
    defaultCategory: (process.env.MEMORY_DEFAULT_CATEGORY ?? 'note') as
      | 'profile'
      | 'preference'
      | 'habit'
      | 'goal'
      | 'todo'
      | 'event'
      | 'knowledge'
      | 'relationship'
      | 'note',
    maxItemsPerTenant: Number(process.env.MEMORY_MAX_ITEMS_PER_TENANT ?? 2500),
    autoCaptureUserMessages: (process.env.MEMORY_AUTO_CAPTURE_USER_MESSAGES ?? 'true').toLowerCase() === 'true',
    hotnessHalfLifeDays: Number(process.env.MEMORY_HOTNESS_HALF_LIFE_DAYS ?? 7)
  },
  mcpHealth: {
    persistEnabled: (process.env.MCP_HEALTH_PERSIST_ENABLED ?? 'true').toLowerCase() === 'true',
    persistenceMode: ((process.env.MCP_HEALTH_PERSIST_MODE ?? 'file').toLowerCase() === 'http' ? 'http' : 'file') as
      | 'file'
      | 'http',
    storeFile: process.env.MCP_HEALTH_STORE_FILE ?? path.resolve(process.cwd(), '.data', 'mcp-health.json'),
    persistHttpUrl: process.env.MCP_HEALTH_PERSIST_HTTP_URL?.trim(),
    persistHttpToken: process.env.MCP_HEALTH_PERSIST_HTTP_TOKEN?.trim(),
    persistHttpTimeoutMs: Number(process.env.MCP_HEALTH_PERSIST_HTTP_TIMEOUT_MS ?? 2500),
    persistDebounceMs: Number(process.env.MCP_HEALTH_PERSIST_DEBOUNCE_MS ?? 750)
  },
  security: {
    masterKey: getMasterKey()
  },
  uiSession: {
    ttlSeconds: Number(process.env.UI_SESSION_TTL_SECONDS ?? 1800),
    maxAuthFailuresPerWindow: Number(process.env.UI_SESSION_MAX_AUTH_FAILURES ?? 5),
    authBlockSeconds: Number(process.env.UI_SESSION_AUTH_BLOCK_SECONDS ?? 120)
  }
};

export type AppConfig = typeof config;
