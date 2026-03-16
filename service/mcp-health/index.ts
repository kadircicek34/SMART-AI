import type { McpServerId } from './types.js';
import { createMcpCircuitBreaker } from './circuit-breaker.js';
import type { McpCircuitBreaker, McpHealthMetrics, McpHealthStatus } from './types.js';

const globalCircuitBreaker = createMcpCircuitBreaker();

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
}

export function recordMcpFailure(serverId: McpServerId, error: string, latencyMs: number): void {
  globalCircuitBreaker.recordFailure(serverId, error, latencyMs);
}

export function resetMcpCircuit(serverId: McpServerId): void {
  globalCircuitBreaker.resetCircuit(serverId);
}

export { createMcpCircuitBreaker } from './circuit-breaker.js';
export type { McpCircuitBreaker, McpHealthConfig, McpHealthMetrics, McpHealthStatus, McpServerId, McpCallResult } from './types.js';