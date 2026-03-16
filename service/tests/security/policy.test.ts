import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceToolPolicy } from '../../security/policy-engine.js';

test('policy allows default tools and denies unknown tools', () => {
  const result = enforceToolPolicy({
    tenantId: 'tenant-default',
    requestedTools: [
      'web_search',
      'wikipedia',
      'deep_research',
      'rag_search',
      'memory_search',
      'qmd_search',
      'mevzuat_mcp_search',
      'borsa_mcp_search',
      'yargi_mcp_search'
    ]
  });

  assert.deepEqual(result.denied, []);
  assert.ok(result.allowed.includes('web_search'));
  assert.ok(result.allowed.includes('wikipedia'));
  assert.ok(result.allowed.includes('deep_research'));
  assert.ok(result.allowed.includes('rag_search'));
  assert.ok(result.allowed.includes('memory_search'));
  assert.ok(result.allowed.includes('qmd_search'));
  assert.ok(result.allowed.includes('mevzuat_mcp_search'));
  assert.ok(result.allowed.includes('borsa_mcp_search'));
  assert.ok(result.allowed.includes('yargi_mcp_search'));
});
