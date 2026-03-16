import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readMcpHealthSnapshotSync, writeMcpHealthSnapshot } from '../../mcp-health/store.js';

test('mcp health snapshot roundtrip works', async () => {
  const filePath = path.join('/tmp', `smart-ai-mcp-health-${Date.now()}-${Math.random()}.json`);

  const sample = {
    servers: {
      mevzuat: {
        serverId: 'mevzuat' as const,
        circuitState: 'closed' as const,
        lastSuccessAt: Date.now(),
        lastFailureAt: null,
        consecutiveFailures: 0,
        consecutiveSuccesses: 1,
        totalCalls: 5,
        totalFailures: 1,
        totalSuccesses: 4,
        avgLatencyMs: 450,
        p95LatencyMs: 800,
        lastError: null,
        lastErrorAt: null
      },
      borsa: {
        serverId: 'borsa' as const,
        circuitState: 'open' as const,
        lastSuccessAt: null,
        lastFailureAt: Date.now(),
        consecutiveFailures: 3,
        consecutiveSuccesses: 0,
        totalCalls: 12,
        totalFailures: 5,
        totalSuccesses: 7,
        avgLatencyMs: 900,
        p95LatencyMs: 1200,
        lastError: 'timeout',
        lastErrorAt: Date.now()
      },
      yargi: {
        serverId: 'yargi' as const,
        circuitState: 'half-open' as const,
        lastSuccessAt: Date.now(),
        lastFailureAt: Date.now(),
        consecutiveFailures: 0,
        consecutiveSuccesses: 1,
        totalCalls: 20,
        totalFailures: 4,
        totalSuccesses: 16,
        avgLatencyMs: 700,
        p95LatencyMs: 1000,
        lastError: null,
        lastErrorAt: null
      }
    },
    globalTotalCalls: 37,
    globalTotalFailures: 10,
    globalAvgLatencyMs: 683,
    updatedAt: Date.now()
  };

  await writeMcpHealthSnapshot(filePath, sample);
  const restored = readMcpHealthSnapshotSync(filePath);

  assert.ok(restored);
  assert.equal(restored?.servers.borsa.circuitState, 'open');
  assert.equal(restored?.globalTotalCalls, 37);

  await fs.rm(filePath, { force: true });
});
