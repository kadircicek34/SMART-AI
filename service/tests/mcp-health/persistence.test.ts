import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHealthPersistence } from '../../mcp-health/persistence.js';

test('mcp health persistence factory returns null when disabled', () => {
  const persistence = createMcpHealthPersistence({
    enabled: false,
    mode: 'file',
    filePath: '/tmp/unused.json',
    httpTimeoutMs: 1000
  });

  assert.equal(persistence, null);
});

test('mcp health persistence factory falls back to file mode without http url', async () => {
  const persistence = createMcpHealthPersistence({
    enabled: true,
    mode: 'http',
    filePath: '/tmp/unused.json',
    httpTimeoutMs: 1000
  });

  assert.ok(persistence);
  const snapshot = await persistence?.read();
  assert.equal(snapshot, null);
});
