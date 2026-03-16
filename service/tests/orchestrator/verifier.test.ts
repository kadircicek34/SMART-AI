import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyEvidence } from '../../orchestrator/verifier.js';

test('verifier suggests rag_search for internal documentation queries when evidence is missing', () => {
  const result = verifyEvidence(
    {
      objective: 'SMART-AI docs',
      tools: ['web_search'],
      reasoning: 'test'
    },
    [],
    'Bu projede API docs endpointleri neler?'
  );

  assert.equal(result.suggestedTool, 'rag_search');
  assert.equal(result.sufficient, false);
});

test('verifier marks response sufficient when strong evidence exists', () => {
  const result = verifyEvidence(
    {
      objective: 'test',
      tools: ['rag_search', 'deep_research'],
      reasoning: 'test'
    },
    [
      {
        tool: 'rag_search',
        summary: 'A'.repeat(120),
        citations: ['local://doc#chk_1']
      },
      {
        tool: 'deep_research',
        summary: 'B'.repeat(130),
        citations: ['https://example.com/a', 'https://example.com/b']
      }
    ],
    'query'
  );

  assert.equal(result.sufficient, true);
  assert.ok(result.confidence >= 0.65);
});
