import type {
  McpCircuitBreaker,
  McpHealthConfig,
  McpHealthMetrics,
  McpHealthStatus,
  McpCallResult,
  McpServerId
} from './types.js';
import { DEFAULT_MCP_HEALTH_CONFIG, MCP_SERVER_IDS } from './types.js';

type LatencyWindow = {
  latencies: number[];
  cursor: number;
};

function createLatencyWindow(size: number): LatencyWindow {
  return {
    latencies: new Array(size).fill(0),
    cursor: 0
  };
}

function pushLatency(window: LatencyWindow, latencyMs: number): void {
  if (window.cursor < window.latencies.length) {
    window.latencies[window.cursor] = latencyMs;
    window.cursor += 1;
  } else {
    window.latencies.shift();
    window.latencies.push(latencyMs);
  }
}

function computePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
}

function createInitialStatus(serverId: McpServerId): McpHealthStatus {
  return {
    serverId,
    circuitState: 'closed',
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    totalCalls: 0,
    totalFailures: 0,
    totalSuccesses: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    lastError: null,
    lastErrorAt: null
  };
}

export function createMcpCircuitBreaker(config: McpHealthConfig = DEFAULT_MCP_HEALTH_CONFIG): McpCircuitBreaker {
  const serverStatuses: Record<McpServerId, McpHealthStatus> = {
    mevzuat: createInitialStatus('mevzuat'),
    borsa: createInitialStatus('borsa'),
    yargi: createInitialStatus('yargi')
  };

  const latencyWindows: Record<McpServerId, LatencyWindow> = {
    mevzuat: createLatencyWindow(config.latencyWindowSize),
    borsa: createLatencyWindow(config.latencyWindowSize),
    yargi: createLatencyWindow(config.latencyWindowSize)
  };

  const halfOpenAttempts: Record<McpServerId, number> = {
    mevzuat: 0,
    borsa: 0,
    yargi: 0
  };

  function now(): number {
    return Date.now();
  }

  function canCall(serverId: McpServerId): boolean {
    const status = serverStatuses[serverId];
    if (!status) return false;

    if (status.circuitState === 'closed') {
      return true;
    }

    if (status.circuitState === 'open') {
      const timeSinceFailure = now() - (status.lastFailureAt ?? 0);
      if (timeSinceFailure >= config.cooldownMs) {
        status.circuitState = 'half-open';
        halfOpenAttempts[serverId] = 0;
        return true;
      }
      return false;
    }

    if (status.circuitState === 'half-open') {
      return halfOpenAttempts[serverId] < config.successThreshold;
    }

    return false;
  }

  function recordSuccess(serverId: McpServerId, latencyMs: number): void {
    const status = serverStatuses[serverId];
    if (!status) return;

    status.lastSuccessAt = now();
    status.consecutiveFailures = 0;
    status.consecutiveSuccesses += 1;
    status.totalCalls += 1;
    status.totalSuccesses += 1;

    pushLatency(latencyWindows[serverId], latencyMs);
    recomputeLatencyStats(serverId);

    if (status.circuitState === 'half-open') {
      halfOpenAttempts[serverId] += 1;
      if (status.consecutiveSuccesses >= config.successThreshold) {
        status.circuitState = 'closed';
        status.lastError = null;
        status.lastErrorAt = null;
        halfOpenAttempts[serverId] = 0;
      }
    }
  }

  function recordFailure(serverId: McpServerId, error: string, latencyMs: number): void {
    const status = serverStatuses[serverId];
    if (!status) return;

    status.lastFailureAt = now();
    status.lastError = error;
    status.lastErrorAt = now();
    status.consecutiveSuccesses = 0;
    status.consecutiveFailures += 1;
    status.totalCalls += 1;
    status.totalFailures += 1;

    pushLatency(latencyWindows[serverId], latencyMs);
    recomputeLatencyStats(serverId);

    if (status.circuitState === 'closed') {
      if (status.consecutiveFailures >= config.failureThreshold) {
        status.circuitState = 'open';
      }
    } else if (status.circuitState === 'half-open') {
      status.circuitState = 'open';
      halfOpenAttempts[serverId] = 0;
    }
  }

  function recomputeLatencyStats(serverId: McpServerId): void {
    const window = latencyWindows[serverId];
    const status = serverStatuses[serverId];
    if (!window || !status) return;

    const validLatencies = window.latencies.filter((l) => l > 0);
    if (validLatencies.length === 0) {
      status.avgLatencyMs = 0;
      status.p95LatencyMs = 0;
      return;
    }

    const sum = validLatencies.reduce((a, b) => a + b, 0);
    status.avgLatencyMs = Math.round(sum / validLatencies.length);

    const sorted = [...validLatencies].sort((a, b) => a - b);
    status.p95LatencyMs = Math.round(computePercentile(sorted, 95));
  }

  function getHealth(): McpHealthMetrics {
    const servers = { ...serverStatuses };
    const allStatuses = MCP_SERVER_IDS.map((id) => serverStatuses[id]);

    const globalTotalCalls = allStatuses.reduce((sum, s) => sum + s.totalCalls, 0);
    const globalTotalFailures = allStatuses.reduce((sum, s) => sum + s.totalFailures, 0);

    const allLatencies = MCP_SERVER_IDS.flatMap((id) =>
      latencyWindows[id].latencies.filter((l) => l > 0)
    );
    const globalAvgLatencyMs =
      allLatencies.length > 0
        ? Math.round(allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length)
        : 0;

    return {
      servers,
      globalTotalCalls,
      globalTotalFailures,
      globalAvgLatencyMs,
      updatedAt: now()
    };
  }

  function getServerHealth(serverId: McpServerId): McpHealthStatus {
    return serverStatuses[serverId] ?? createInitialStatus(serverId);
  }

  function getAdaptiveTimeout(serverId: McpServerId): number {
    const status = serverStatuses[serverId];
    if (!status) return config.timeoutMs;

    if (status.totalCalls < 5) {
      return config.timeoutMs;
    }

    const baseTimeout = Math.max(status.p95LatencyMs * 1.5, status.avgLatencyMs * 2);
    const adapted =
      config.timeoutMs * (1 - config.timeoutAdaptationFactor) +
      baseTimeout * config.timeoutAdaptationFactor;

    return Math.max(config.minTimeoutMs, Math.min(config.maxTimeoutMs, Math.round(adapted)));
  }

  function resetCircuit(serverId: McpServerId): void {
    const status = serverStatuses[serverId];
    if (!status) return;

    status.circuitState = 'closed';
    status.consecutiveFailures = 0;
    status.consecutiveSuccesses = 0;
    status.lastError = null;
    status.lastErrorAt = null;
    halfOpenAttempts[serverId] = 0;
  }

  return {
    canCall,
    recordSuccess,
    recordFailure,
    getHealth,
    getServerHealth,
    getAdaptiveTimeout,
    resetCircuit
  };
}

export const __private__ = {
  createLatencyWindow,
  pushLatency,
  computePercentile,
  createInitialStatus
};