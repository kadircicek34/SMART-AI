import { config } from '../config.js';
import type { McpServerId } from './types.js';
import { createMcpCircuitBreaker } from './circuit-breaker.js';
import { createMcpHealthPersistence } from './persistence.js';
import type { McpCircuitBreaker, McpHealthMetrics, McpHealthStatus } from './types.js';

const persistence = createMcpHealthPersistence({
  enabled: config.mcpHealth.persistEnabled,
  mode: config.mcpHealth.persistenceMode,
  filePath: config.mcpHealth.storeFile,
  httpUrl: config.mcpHealth.persistHttpUrl,
  httpToken: config.mcpHealth.persistHttpToken,
  httpTimeoutMs: config.mcpHealth.persistHttpTimeoutMs
});

const globalCircuitBreaker = createMcpCircuitBreaker();
let seedLoaded = false;

async function ensureSeedLoaded(): Promise<void> {
  if (!persistence || seedLoaded) return;
  seedLoaded = true;

  const snapshot = await persistence.read();
  if (!snapshot) return;

  for (const serverId of ['mevzuat', 'borsa', 'yargi'] as const) {
    const server = snapshot.servers[serverId];
    if (!server) continue;

    if (server.circuitState === 'open') {
      globalCircuitBreaker.recordFailure(serverId, server.lastError ?? 'seeded-open-state', server.avgLatencyMs || 1000);
    }
  }
}

let persistTimer: NodeJS.Timeout | null = null;

function schedulePersist(): void {
  if (!persistence) return;
  if (persistTimer) return;

  persistTimer = setTimeout(() => {
    persistTimer = null;

    void persistence.write(globalCircuitBreaker.getHealth()).catch(() => {
      // non-fatal background persistence failure
    });
  }, Math.max(100, config.mcpHealth.persistDebounceMs));
}

export function getMcpCircuitBreaker(): McpCircuitBreaker {
  void ensureSeedLoaded();
  return globalCircuitBreaker;
}

export function getMcpHealth(): McpHealthMetrics {
  void ensureSeedLoaded();
  return globalCircuitBreaker.getHealth();
}

export function getMcpServerHealth(serverId: McpServerId): McpHealthStatus {
  void ensureSeedLoaded();
  return globalCircuitBreaker.getServerHealth(serverId);
}

export function canCallMcp(serverId: McpServerId): boolean {
  void ensureSeedLoaded();
  return globalCircuitBreaker.canCall(serverId);
}

export function getMcpAdaptiveTimeout(serverId: McpServerId): number {
  void ensureSeedLoaded();
  return globalCircuitBreaker.getAdaptiveTimeout(serverId);
}

export function recordMcpSuccess(serverId: McpServerId, latencyMs: number): void {
  void ensureSeedLoaded();
  globalCircuitBreaker.recordSuccess(serverId, latencyMs);
  schedulePersist();
}

export function recordMcpFailure(serverId: McpServerId, error: string, latencyMs: number): void {
  void ensureSeedLoaded();
  globalCircuitBreaker.recordFailure(serverId, error, latencyMs);
  schedulePersist();
}

export function resetMcpCircuit(serverId: McpServerId): void {
  void ensureSeedLoaded();
  globalCircuitBreaker.resetCircuit(serverId);
  schedulePersist();
}

export async function flushMcpHealthSnapshot(): Promise<void> {
  if (!persistence) return;
  await ensureSeedLoaded();
  await persistence.write(globalCircuitBreaker.getHealth());
}

export { createMcpCircuitBreaker } from './circuit-breaker.js';
export type {
  McpCircuitBreaker,
  McpHealthConfig,
  McpHealthMetrics,
  McpHealthStatus,
  McpServerId,
  McpCallResult
} from './types.js';
