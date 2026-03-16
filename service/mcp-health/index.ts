import { config } from '../config.js';
import type { McpServerId } from './types.js';
import { createMcpCircuitBreaker } from './circuit-breaker.js';
import { readMcpHealthSnapshotSync, writeMcpHealthSnapshot } from './store.js';
import type { McpCircuitBreaker, McpHealthMetrics, McpHealthStatus } from './types.js';

const seedSnapshot = config.mcpHealth.persistEnabled
  ? readMcpHealthSnapshotSync(config.mcpHealth.storeFile)
  : null;

const globalCircuitBreaker = createMcpCircuitBreaker(undefined, seedSnapshot ?? undefined);

let persistTimer: NodeJS.Timeout | null = null;

function schedulePersist(): void {
  if (!config.mcpHealth.persistEnabled) return;
  if (persistTimer) return;

  persistTimer = setTimeout(() => {
    persistTimer = null;

    void writeMcpHealthSnapshot(config.mcpHealth.storeFile, globalCircuitBreaker.getHealth()).catch(() => {
      // non-fatal background persistence failure
    });
  }, Math.max(100, config.mcpHealth.persistDebounceMs));
}

export function getMcpCircuitBreaker(): McpCircuitBreaker {
  return globalCircuitBreaker;
}

export function getMcpHealth(): McpHealthMetrics {
  return globalCircuitBreaker.getHealth();
}

export function getMcpServerHealth(serverId: McpServerId): McpHealthStatus {
  return globalCircuitBreaker.getServerHealth(serverId);
}

export function canCallMcp(serverId: McpServerId): boolean {
  return globalCircuitBreaker.canCall(serverId);
}

export function getMcpAdaptiveTimeout(serverId: McpServerId): number {
  return globalCircuitBreaker.getAdaptiveTimeout(serverId);
}

export function recordMcpSuccess(serverId: McpServerId, latencyMs: number): void {
  globalCircuitBreaker.recordSuccess(serverId, latencyMs);
  schedulePersist();
}

export function recordMcpFailure(serverId: McpServerId, error: string, latencyMs: number): void {
  globalCircuitBreaker.recordFailure(serverId, error, latencyMs);
  schedulePersist();
}

export function resetMcpCircuit(serverId: McpServerId): void {
  globalCircuitBreaker.resetCircuit(serverId);
  schedulePersist();
}

export async function flushMcpHealthSnapshot(): Promise<void> {
  if (!config.mcpHealth.persistEnabled) return;
  await writeMcpHealthSnapshot(config.mcpHealth.storeFile, globalCircuitBreaker.getHealth());
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
