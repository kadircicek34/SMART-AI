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

const parseNumberCsv = (value: string | undefined): number[] =>
  parseCsv(value)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry > 0);

const parseBoolean = (value: string | undefined, fallback = false): boolean => {
  if (value === undefined) {
    return fallback;
  }

  return value.trim().toLowerCase() === 'true';
};

const parseCitationMode = (value: string | undefined): 'always' | 'on_demand' | 'never' => {
  const normalized = (value ?? 'on_demand').trim().toLowerCase();
  if (normalized === 'always' || normalized === 'never') {
    return normalized;
  }

  return 'on_demand';
};

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
    minSourceDomains: Number(process.env.VERIFIER_MIN_SOURCE_DOMAINS ?? 2),
    minSimplicityScore: Number(process.env.VERIFIER_MIN_SIMPLICITY_SCORE ?? 0.58)
  },
  synthesizer: {
    citationMode: parseCitationMode(process.env.SYNTHESIS_CITATION_MODE),
    forceSourcesWhenVerificationLow: parseBoolean(process.env.SYNTHESIS_FORCE_SOURCES_WHEN_VERIFICATION_LOW, false)
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
    qmdEmbeddingFallbackEnabled:
      (process.env.QMD_EMBEDDING_FALLBACK_ENABLED ?? (process.env.OPENAI_API_KEY ? 'true' : 'false')).toLowerCase() === 'true',
    qmdEmbeddingFallbackOpenAiApiKey: process.env.QMD_EMBEDDING_FALLBACK_OPENAI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim(),
    qmdEmbeddingFallbackOpenAiBaseUrl:
      process.env.QMD_EMBEDDING_FALLBACK_OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1',
    qmdEmbeddingFallbackModel: process.env.QMD_EMBEDDING_FALLBACK_MODEL?.trim() || 'text-embedding-3-small',
    qmdEmbeddingFallbackTimeoutMs: Number(process.env.QMD_EMBEDDING_FALLBACK_TIMEOUT_MS ?? 12_000),
    qmdEmbeddingFallbackCandidateLimit: Number(process.env.QMD_EMBEDDING_FALLBACK_CANDIDATE_LIMIT ?? 24),
    qmdEmbeddingFallbackMaxInputChars: Number(process.env.QMD_EMBEDDING_FALLBACK_MAX_INPUT_CHARS ?? 4_000),
    qmdEmbeddingFallbackMinScore: Number(process.env.QMD_EMBEDDING_FALLBACK_MIN_SCORE ?? 0.2),
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
    ragRemotePolicyFile:
      process.env.RAG_REMOTE_POLICY_FILE ?? path.resolve(process.cwd(), '.data', 'tenant-rag-remote-policies.json'),
    uiSessionStoreFile: process.env.UI_SESSION_STORE_FILE ?? path.resolve(process.cwd(), '.data', 'ui-sessions.json'),
    securityAuditStoreFile: process.env.SECURITY_AUDIT_STORE_FILE ?? path.resolve(process.cwd(), '.data', 'security-audit.json'),
    securityExportDeliveryStoreFile:
      process.env.SECURITY_EXPORT_DELIVERY_STORE_FILE ??
      path.resolve(process.cwd(), '.data', 'security-export-deliveries.json'),
    securityExportDeliveryPolicyFile:
      process.env.SECURITY_EXPORT_DELIVERY_POLICY_FILE ??
      path.resolve(process.cwd(), '.data', 'security-export-delivery-policies.json'),
    securityExportOperatorPolicyFile:
      process.env.SECURITY_EXPORT_OPERATOR_POLICY_FILE ??
      path.resolve(process.cwd(), '.data', 'security-export-operator-policies.json'),
    securityExportOperatorDelegationFile:
      process.env.SECURITY_EXPORT_OPERATOR_DELEGATION_FILE ??
      path.resolve(process.cwd(), '.data', 'security-export-operator-delegations.json'),
    securityExportSigningStoreFile:
      process.env.SECURITY_EXPORT_SIGNING_STORE_FILE ??
      path.resolve(process.cwd(), '.data', 'security-export-signing-keys.json'),
    qmdEmbeddingFallbackCacheFile:
      process.env.QMD_EMBEDDING_FALLBACK_CACHE_FILE ?? path.resolve(process.cwd(), '.data', 'qmd-embedding-cache.json')
  },
  rag: {
    storeFile: process.env.RAG_STORE_FILE ?? path.resolve(process.cwd(), '.data', 'rag-store.json'),
    defaultChunkSize: Number(process.env.RAG_DEFAULT_CHUNK_SIZE ?? 1_200),
    defaultChunkOverlap: Number(process.env.RAG_DEFAULT_CHUNK_OVERLAP ?? 180),
    remoteFetchTimeoutMs: Number(process.env.RAG_REMOTE_FETCH_TIMEOUT_MS ?? 15_000),
    remoteFetchMaxBytes: Number(process.env.RAG_REMOTE_FETCH_MAX_BYTES ?? 1_000_000),
    remoteFetchMaxRedirects: Number(process.env.RAG_REMOTE_FETCH_MAX_REDIRECTS ?? 3),
    remotePreviewChars: Number(process.env.RAG_REMOTE_PREVIEW_CHARS ?? 600),
    remotePolicyDefaultMode: ((process.env.RAG_REMOTE_POLICY_DEFAULT_MODE ?? 'preview_only').trim().toLowerCase() ||
      'preview_only') as 'disabled' | 'preview_only' | 'allowlist_only' | 'open',
    remotePolicyDefaultAllowedHosts: parseCsv(process.env.RAG_REMOTE_POLICY_DEFAULT_ALLOWED_HOSTS),
    remotePolicyMaxAllowedHosts: Number(process.env.RAG_REMOTE_POLICY_MAX_ALLOWED_HOSTS ?? 32),
    remoteUserAgent: process.env.RAG_REMOTE_USER_AGENT?.trim() || 'SMART-AI-RAG/1.0',
    remoteAllowedPorts: (() => {
      const parsed = parseNumberCsv(process.env.RAG_REMOTE_ALLOWED_PORTS);
      return parsed.length > 0 ? parsed : [80, 443];
    })(),
    remoteAllowedContentTypes: (() => {
      const parsed = parseCsv(process.env.RAG_REMOTE_ALLOWED_CONTENT_TYPES).map((entry) => entry.toLowerCase());
      return parsed.length > 0
        ? parsed
        : ['text/html', 'text/plain', 'text/markdown', 'application/json', 'application/xml', 'text/xml', 'application/xhtml+xml'];
    })()
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
    uiApiKeyMaxLength: Number(process.env.SECURITY_UI_API_KEY_MAX_LENGTH ?? 512),
    exportDeliveryTimeoutMs: Number(process.env.SECURITY_EXPORT_DELIVERY_TIMEOUT_MS ?? 10_000),
    exportDeliveryMaxResponseBytes: Number(process.env.SECURITY_EXPORT_DELIVERY_MAX_RESPONSE_BYTES ?? 32_768),
    exportDeliveryMaxRecordsPerTenant: Number(process.env.SECURITY_EXPORT_DELIVERY_MAX_RECORDS_PER_TENANT ?? 100),
    exportDeliveryMaxActivePerTenant: Number(process.env.SECURITY_EXPORT_DELIVERY_MAX_ACTIVE_PER_TENANT ?? 10),
    exportDeliveryIdempotencyTtlSeconds: Number(process.env.SECURITY_EXPORT_DELIVERY_IDEMPOTENCY_TTL_SECONDS ?? 3600),
    exportDeliveryIdempotencyKeyMaxLength: Number(process.env.SECURITY_EXPORT_DELIVERY_IDEMPOTENCY_KEY_MAX_LENGTH ?? 128),
    exportDeliveryRetryBaseDelayMs: Number(process.env.SECURITY_EXPORT_DELIVERY_RETRY_BASE_DELAY_MS ?? 5_000),
    exportDeliveryRetryMaxDelayMs: Number(process.env.SECURITY_EXPORT_DELIVERY_RETRY_MAX_DELAY_MS ?? 60_000),
    exportDeliveryMaxAttempts: Number(process.env.SECURITY_EXPORT_DELIVERY_MAX_ATTEMPTS ?? 4),
    exportDeliveryMaxManualRedrives: Number(process.env.SECURITY_EXPORT_DELIVERY_MAX_MANUAL_REDRIVES ?? 2),
    exportDeliveryIncidentWindowHours: Number(process.env.SECURITY_EXPORT_DELIVERY_INCIDENT_WINDOW_HOURS ?? 24),
    exportDeliveryQuarantineFailureThreshold: Number(process.env.SECURITY_EXPORT_DELIVERY_QUARANTINE_FAILURE_THRESHOLD ?? 3),
    exportDeliveryQuarantineDeadLetterThreshold: Number(process.env.SECURITY_EXPORT_DELIVERY_QUARANTINE_DEAD_LETTER_THRESHOLD ?? 2),
    exportDeliveryQuarantineDurationMinutes: Number(process.env.SECURITY_EXPORT_DELIVERY_QUARANTINE_DURATION_MINUTES ?? 60),
    exportDeliveryClearRequestTtlMinutes: Number(process.env.SECURITY_EXPORT_DELIVERY_CLEAR_REQUEST_TTL_MINUTES ?? 30),
    exportDeliveryUserAgent:
      process.env.SECURITY_EXPORT_DELIVERY_USER_AGENT?.trim() || 'SMART-AI-Security-Delivery/1.0',
    exportDeliveryPolicyDefaultMode: ((process.env.SECURITY_EXPORT_DELIVERY_POLICY_DEFAULT_MODE ?? '').trim().toLowerCase() ||
      (parseCsv(process.env.SECURITY_EXPORT_DELIVERY_POLICY_DEFAULT_ALLOWED_TARGETS).length > 0 ? 'allowlist_only' : 'inherit_remote_policy')) as
      | 'inherit_remote_policy'
      | 'disabled'
      | 'allowlist_only',
    exportDeliveryPolicyDefaultAllowedTargets: parseCsv(process.env.SECURITY_EXPORT_DELIVERY_POLICY_DEFAULT_ALLOWED_TARGETS),
    exportDeliveryPolicyMaxAllowedTargets: Number(process.env.SECURITY_EXPORT_DELIVERY_POLICY_MAX_ALLOWED_TARGETS ?? 32),
    exportOperatorPolicyDefaultMode: ((process.env.SECURITY_EXPORT_OPERATOR_POLICY_DEFAULT_MODE ?? '').trim().toLowerCase() ||
      (parseCsv(process.env.SECURITY_EXPORT_OPERATOR_POLICY_DEFAULT_ACKNOWLEDGERS).length > 0 ||
      parseCsv(process.env.SECURITY_EXPORT_OPERATOR_POLICY_DEFAULT_CLEAR_REQUESTERS).length > 0 ||
      parseCsv(process.env.SECURITY_EXPORT_OPERATOR_POLICY_DEFAULT_CLEAR_APPROVERS).length > 0
        ? 'roster_required'
        : 'open_admins')) as 'open_admins' | 'roster_required',
    exportOperatorPolicyDefaultAcknowledgers: parseCsv(process.env.SECURITY_EXPORT_OPERATOR_POLICY_DEFAULT_ACKNOWLEDGERS),
    exportOperatorPolicyDefaultClearRequesters: parseCsv(process.env.SECURITY_EXPORT_OPERATOR_POLICY_DEFAULT_CLEAR_REQUESTERS),
    exportOperatorPolicyDefaultClearApprovers: parseCsv(process.env.SECURITY_EXPORT_OPERATOR_POLICY_DEFAULT_CLEAR_APPROVERS),
    exportOperatorPolicyMaxPrincipalsPerRole: Number(process.env.SECURITY_EXPORT_OPERATOR_POLICY_MAX_PRINCIPALS_PER_ROLE ?? 32),
    exportOperatorDelegationDefaultTtlMinutes: Number(process.env.SECURITY_EXPORT_OPERATOR_DELEGATION_DEFAULT_TTL_MINUTES ?? 30),
    exportOperatorDelegationMaxTtlMinutes: Number(process.env.SECURITY_EXPORT_OPERATOR_DELEGATION_MAX_TTL_MINUTES ?? 120),
    exportOperatorDelegationMaxActivePerTenant: Number(process.env.SECURITY_EXPORT_OPERATOR_DELEGATION_MAX_ACTIVE_PER_TENANT ?? 8),
    exportOperatorDelegationMaxPendingPerTenant: Number(process.env.SECURITY_EXPORT_OPERATOR_DELEGATION_MAX_PENDING_PER_TENANT ?? 12),
    exportOperatorDelegationApprovalTtlMinutes: Number(process.env.SECURITY_EXPORT_OPERATOR_DELEGATION_APPROVAL_TTL_MINUTES ?? 15),
    exportOperatorDelegationStepUpMaxAgeSeconds: Number(process.env.SECURITY_EXPORT_OPERATOR_DELEGATION_STEP_UP_MAX_AGE_SECONDS ?? 600),
    exportSigningMaxVerifyKeys: Number(process.env.SECURITY_EXPORT_SIGNING_MAX_VERIFY_KEYS ?? 4),
    exportSigningAutoRotateEnabled: (process.env.SECURITY_EXPORT_SIGNING_AUTO_ROTATE_ENABLED ?? 'true').toLowerCase() === 'true',
    exportSigningRotateAfterHours: Number(process.env.SECURITY_EXPORT_SIGNING_ROTATE_AFTER_HOURS ?? 720),
    exportSigningExpireAfterHours: Number(process.env.SECURITY_EXPORT_SIGNING_EXPIRE_AFTER_HOURS ?? 1080),
    exportSigningWarnBeforeHours: Number(process.env.SECURITY_EXPORT_SIGNING_WARN_BEFORE_HOURS ?? 168),
    exportSigningVerifyRetentionHours: Number(process.env.SECURITY_EXPORT_SIGNING_VERIFY_RETENTION_HOURS ?? 2160),
    exportSigningMaintenanceIntervalMs: Number(process.env.SECURITY_EXPORT_SIGNING_MAINTENANCE_INTERVAL_MS ?? 300000),
    exportSigningMaintenanceLeaseTtlMs: (() => {
      const configured = Number(process.env.SECURITY_EXPORT_SIGNING_MAINTENANCE_LEASE_TTL_MS ?? 0);
      if (Number.isFinite(configured) && configured > 0) {
        return Math.max(1000, Math.round(configured));
      }

      const interval = Number(process.env.SECURITY_EXPORT_SIGNING_MAINTENANCE_INTERVAL_MS ?? 300000);
      return Math.max(60_000, Math.round(interval * 2));
    })(),
    exportSigningMaintenanceHistoryLimit: Number(process.env.SECURITY_EXPORT_SIGNING_MAINTENANCE_HISTORY_LIMIT ?? 25),
    exportDeliveryAllowedPorts: (() => {
      const parsed = parseNumberCsv(process.env.SECURITY_EXPORT_DELIVERY_ALLOWED_PORTS);
      return parsed.length > 0 ? parsed : [443];
    })(),
    exportDeliveryAllowIpLiterals: parseBoolean(process.env.SECURITY_EXPORT_DELIVERY_ALLOW_IP_LITERALS, false)
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
