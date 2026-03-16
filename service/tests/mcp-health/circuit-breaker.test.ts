import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpCircuitBreaker } from '../../mcp-health/circuit-breaker.js';

test('circuit opens after threshold failures and blocks calls', () => {
  const breaker = createMcpCircuitBreaker({
    failureThreshold: 2,
    successThreshold: 1,
    cooldownMs: 60_000,
    latencyWindowSize: 10,
    timeoutMs: 12_000,
    minTimeoutMs: 5_000,
    maxTimeoutMs: 45_000,
    timeoutAdaptationFactor: 0.35
  });

  assert.equal(breaker.canCall('mevzuat'), true);
  breaker.recordFailure('mevzuat', 'timeout', 1000);
  assert.equal(breaker.canCall('mevzuat'), true);

  breaker.recordFailure('mevzuat', 'timeout', 1200);
  assert.equal(breaker.getServerHealth('mevzuat').circuitState, 'open');
  assert.equal(breaker.canCall('mevzuat'), false);
});

test('adaptive timeout increases for slower servers after enough calls', () => {
  const breaker = createMcpCircuitBreaker();

  for (let i = 0; i < 8; i += 1) {
    breaker.recordSuccess('borsa', 8_000 + i * 100);
  }

  const adapted = breaker.getAdaptiveTimeout('borsa');
  assert.ok(adapted >= 5_000);
  assert.ok(adapted <= 45_000);
  assert.ok(adapted > 12_000);
});

test('circuit breaker can be hydrated from persisted seed snapshot', () => {
  const breaker = createMcpCircuitBreaker(undefined, {
    servers: {
      mevzuat: {
        serverId: 'mevzuat',
        circuitState: 'open',
        lastSuccessAt: null,
        lastFailureAt: Date.now(),
        consecutiveFailures: 4,
        consecutiveSuccesses: 0,
        totalCalls: 14,
        totalFailures: 8,
        totalSuccesses: 6,
        avgLatencyMs: 1200,
        p95LatencyMs: 1700,
        lastError: 'timeout',
        lastErrorAt: Date.now()
      },
      borsa: {
        serverId: 'borsa',
        circuitState: 'closed',
        lastSuccessAt: Date.now(),
        lastFailureAt: null,
        consecutiveFailures: 0,
        consecutiveSuccesses: 2,
        totalCalls: 10,
        totalFailures: 1,
        totalSuccesses: 9,
        avgLatencyMs: 500,
        p95LatencyMs: 800,
        lastError: null,
        lastErrorAt: null
      },
      yargi: {
        serverId: 'yargi',
        circuitState: 'half-open',
        lastSuccessAt: Date.now(),
        lastFailureAt: Date.now() - 10_000,
        consecutiveFailures: 0,
        consecutiveSuccesses: 1,
        totalCalls: 20,
        totalFailures: 5,
        totalSuccesses: 15,
        avgLatencyMs: 900,
        p95LatencyMs: 1300,
        lastError: null,
        lastErrorAt: null
      }
    },
    globalTotalCalls: 44,
    globalTotalFailures: 14,
    globalAvgLatencyMs: 866,
    updatedAt: Date.now()
  });

  assert.equal(breaker.getServerHealth('mevzuat').circuitState, 'open');
  assert.equal(breaker.canCall('mevzuat'), false);
  assert.ok(breaker.getAdaptiveTimeout('borsa') >= 5_000);
});
