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
