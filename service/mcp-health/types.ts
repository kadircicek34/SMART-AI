export const MCP_SERVER_IDS = ['mevzuat', 'borsa', 'yargi'] as const;

export type McpServerId = (typeof MCP_SERVER_IDS)[number];

export type McpCircuitState = 'closed' | 'open' | 'half-open';

export type McpCallResult = {
  ok: boolean;
  error?: string;
  latencyMs: number;
};

export type McpHealthStatus = {
  serverId: McpServerId;
  circuitState: McpCircuitState;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  totalCalls: number;
  totalFailures: number;
  totalSuccesses: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  lastError: string | null;
  lastErrorAt: number | null;
};

export type McpHealthMetrics = {
  servers: Record<McpServerId, McpHealthStatus>;
  globalTotalCalls: number;
  globalTotalFailures: number;
  globalAvgLatencyMs: number;
  updatedAt: number;
};

export type McpHealthConfig = {
  failureThreshold: number;
  successThreshold: number;
  cooldownMs: number;
  latencyWindowSize: number;
  timeoutMs: number;
  minTimeoutMs: number;
  maxTimeoutMs: number;
  timeoutAdaptationFactor: number;
};

export type McpCircuitBreaker = {
  canCall: (serverId: McpServerId) => boolean;
  recordSuccess: (serverId: McpServerId, latencyMs: number) => void;
  recordFailure: (serverId: McpServerId, error: string, latencyMs: number) => void;
  getHealth: () => McpHealthMetrics;
  getServerHealth: (serverId: McpServerId) => McpHealthStatus;
  getAdaptiveTimeout: (serverId: McpServerId) => number;
  resetCircuit: (serverId: McpServerId) => void;
};

export const DEFAULT_MCP_HEALTH_CONFIG: McpHealthConfig = {
  failureThreshold: 3,
  successThreshold: 2,
  cooldownMs: 60_000,
  latencyWindowSize: 30,
  timeoutMs: 12_000,
  minTimeoutMs: 5_000,
  maxTimeoutMs: 45_000,
  timeoutAdaptationFactor: 0.35
};
