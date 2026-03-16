import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceToolPolicy } from '../../security/policy-engine.js';

test('policy allows default tools and denies unknown tools', () => {
  const result = enforceToolPolicy({
    tenantId: 'tenant-default',
    requestedTools: ['web_search', 'wikipedia', 'deep_research', 'rag_search']
  });

  assert.deepEqual(result.denied, []);
  assert.ok(result.allowed.includes('web_search'));
  assert.ok(result.allowed.includes('wikipedia'));
  assert.ok(result.allowed.includes('deep_research'));
  assert.ok(result.allowed.includes('rag_search'));
});
