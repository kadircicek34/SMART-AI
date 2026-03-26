import crypto from 'node:crypto';
import path from 'node:path';
import { normalizeAuthScopes, type AuthScope } from './security/authz.js';

const parseCsv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

const parseOrigins = (value: string | undefined): string[] =>
  parseCsv(value)
    .map((origin) => origin.toLowerCase())
    .filter((origin) => origin.startsWith('http://') || origin.startsWith('https://'));

type AppApiKeyDefinition = {
  name: string;
  key: string;
  scopes: AuthScope[];
};

function parseAppApiKeyDefinitions(value: string | undefined): AppApiKeyDefinition[] {
  if (!value?.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid APP_API_KEY_DEFINITIONS JSON: ${(error as Error).message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Invalid APP_API_KEY_DEFINITIONS JSON: expected an array.');
  }

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Invalid APP_API_KEY_DEFINITIONS entry at index ${index}: expected object.`);
    }

    const candidate = entry as {
      name?: unknown;
      key?: unknown;
      scopes?: unknown;
    };

    const key = String(candidate.key ?? '').trim();
    if (!key) {
      throw new Error(`Invalid APP_API_KEY_DEFINITIONS entry at index ${index}: key is required.`);
    }

    const name = String(candidate.name ?? `key-${index + 1}`).trim() || `key-${index + 1}`;
    const scopes = normalizeAuthScopes(Array.isArray(candidate.scopes) ? candidate.scopes.map((item) => String(item)) : []);
    if (scopes.length === 0) {
      throw new Error(`Invalid APP_API_KEY_DEFINITIONS entry at index ${index}: at least one valid scope is required.`);
    }

    return {
      name,
      key,
      scopes
    } satisfies AppApiKeyDefinition;
  });
}

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

    if ((process.env.NODE_ENV ?? 'development') === 'production') {
      throw new Error('Invalid MASTER_KEY_BASE64: expected base64-encoded key with at least 32 bytes.');
    }
  }

  if ((process.env.NODE_ENV ?? 'development') === 'production') {
    throw new Error('MASTER_KEY_BASE64 is required in production.');
  }

  // deterministic fallback for local dev/test only
  return crypto.createHash('sha256').update('dev-master-key-change-me').digest();
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  isProd: (process.env.NODE_ENV ?? 'development') === 'production',
  port: Number(process.env.PORT ?? 8080),
  appApiKeys: parseCsv(process.env.APP_API_KEYS),
  appApiKeyDefinitions: parseAppApiKeyDefinitions(process.env.APP_API_KEY_DEFINITIONS),
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
    maxConcurrentUnits: Number(process.env.RESEARCH_MAX_CONCURRENT_UNITS ?? 2),
    maxQueryChars: Number(process.env.RESEARCH_MAX_QUERY_CHARS ?? 4_000),
    maxActiveJobsPerTenant: Number(process.env.RESEARCH_MAX_ACTIVE_JOBS_PER_TENANT ?? 2),
    idempotencyKeyMaxLength: Number(process.env.RESEARCH_IDEMPOTENCY_KEY_MAX_LENGTH ?? 128),
    idempotencyTtlSeconds: Number(process.env.RESEARCH_IDEMPOTENCY_TTL_SECONDS ?? 3600),
    jobTimeoutMs: Number(process.env.RESEARCH_JOB_TIMEOUT_MS ?? 120_000),
    maxJobsPerTenant: Number(process.env.RESEARCH_MAX_JOBS_PER_TENANT ?? 500)
  },
  openRouter: {
    baseUrl: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
    defaultModel: process.env.OPENROUTER_DEFAULT_MODEL ?? 'deepseek/deepseek-chat-v3.1',
    allowedModels: (() => {
      const configured = parseCsv(process.env.OPENROUTER_ALLOWED_MODELS);
      if (configured.length > 0) {
        return configured;
      }

      return [process.env.OPENROUTER_DEFAULT_MODEL ?? 'deepseek/deepseek-chat-v3.1'];
    })(),
    maxTenantAllowedModels: Number(process.env.OPENROUTER_MAX_TENANT_ALLOWED_MODELS ?? 12),
    modelIdMaxLength: Number(process.env.OPENROUTER_MODEL_ID_MAX_LENGTH ?? 120),
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
    yargiMcpFallbackEnabled: (process.env.YARGI_MCP_FALLBACK_ENABLED ?? 'true').toLowerCase() === 'true',
    openbbEnabled:
      (process.env.OPENBB_ENABLED ?? (process.env.OPENBB_API_BASE_URL ? 'true' : 'false')).toLowerCase() === 'true',
    openbbApiBaseUrl: process.env.OPENBB_API_BASE_URL?.trim() ?? '',
    openbbApiPrefix: process.env.OPENBB_API_PREFIX?.trim() || '/api/v1',
    openbbApiTimeoutMs: Number(process.env.OPENBB_API_TIMEOUT_MS ?? 12_000),
    openbbProvider: process.env.OPENBB_PROVIDER?.trim() || 'yfinance',
    openbbNewsProvider: process.env.OPENBB_NEWS_PROVIDER?.trim() || 'benzinga',
    openbbWorldNewsProvider: process.env.OPENBB_WORLD_NEWS_PROVIDER?.trim() || 'fmp',
    openbbAuthToken: process.env.OPENBB_AUTH_TOKEN?.trim(),
    openbbUsername: process.env.OPENBB_USERNAME?.trim(),
    openbbPassword: process.env.OPENBB_PASSWORD?.trim(),
    openbbMaxSymbols: Number(process.env.OPENBB_MAX_SYMBOLS ?? 3),
    openbbHistoryLimit: Number(process.env.OPENBB_HISTORY_LIMIT ?? 60),
    openbbNewsLimit: Number(process.env.OPENBB_NEWS_LIMIT ?? 6)
  },
  storage: {
    root: process.env.DATA_DIR ?? path.resolve(process.cwd(), '.data'),
    keyStoreFile: process.env.KEY_STORE_FILE ?? path.resolve(process.cwd(), '.data', 'tenant-keys.json'),
    modelPolicyFile: process.env.MODEL_POLICY_FILE ?? path.resolve(process.cwd(), '.data', 'tenant-model-policies.json'),
    uiSessionStoreFile: process.env.UI_SESSION_STORE_FILE ?? path.resolve(process.cwd(), '.data', 'ui-sessions.json'),
    securityAuditStoreFile: process.env.SECURITY_AUDIT_STORE_FILE ?? path.resolve(process.cwd(), '.data', 'security-audit.json')
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
    masterKey: getMasterKey(),
    auditMaxEventsPerTenant: Number(process.env.SECURITY_AUDIT_MAX_EVENTS_PER_TENANT ?? 300),
    auditPersistDebounceMs: Number(process.env.SECURITY_AUDIT_PERSIST_DEBOUNCE_MS ?? 250),
    authorizationHeaderMaxLength: Number(process.env.SECURITY_AUTH_HEADER_MAX_LENGTH ?? 4096),
    bearerTokenMaxLength: Number(process.env.SECURITY_BEARER_TOKEN_MAX_LENGTH ?? 2048),
    tenantHeaderMaxLength: Number(process.env.SECURITY_TENANT_HEADER_MAX_LENGTH ?? 128),
    uiApiKeyMaxLength: Number(process.env.SECURITY_UI_API_KEY_MAX_LENGTH ?? 512)
  },
  ui: {
    allowedOrigins: parseOrigins(process.env.UI_ALLOWED_ORIGINS)
  },
  uiSession: {
    ttlSeconds: Number(process.env.UI_SESSION_TTL_SECONDS ?? 1800),
    maxIdleSeconds: Number(process.env.UI_SESSION_MAX_IDLE_SECONDS ?? 900),
    maxAuthFailuresPerWindow: Number(process.env.UI_SESSION_MAX_AUTH_FAILURES ?? 5),
    authBlockSeconds: Number(process.env.UI_SESSION_AUTH_BLOCK_SECONDS ?? 120),
    maxSessionsPerTenant: Number(process.env.UI_SESSION_MAX_SESSIONS_PER_TENANT ?? 5),
    maxSessionsGlobal: Number(process.env.UI_SESSION_MAX_SESSIONS_GLOBAL ?? 2000),
    persistDebounceMs: Number(process.env.UI_SESSION_PERSIST_DEBOUNCE_MS ?? 250)
  }
};

export type AppConfig = typeof config;
