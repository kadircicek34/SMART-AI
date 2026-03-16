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
    braveApiKey: process.env.BRAVE_API_KEY,
    braveApiBaseUrl: process.env.BRAVE_API_BASE_URL ?? 'https://api.search.brave.com/res/v1/web/search'
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
  security: {
    masterKey: getMasterKey()
  }
};

export type AppConfig = typeof config;
