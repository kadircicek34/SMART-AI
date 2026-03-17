import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planForQuery } from '../../orchestrator/planner.js';

test('planner creates stage checklist for research queries', () => {
  const plan = planForQuery('Projede bu endpointi araştır ve karşılaştır');

  assert.ok(Array.isArray(plan.stages));
  assert.ok((plan.stages?.length ?? 0) >= 1);
  assert.ok(plan.stages?.some((stage) => stage.title.includes('Keşif')));
});
