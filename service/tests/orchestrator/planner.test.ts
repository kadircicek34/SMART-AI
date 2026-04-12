import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planForQuery } from '../../orchestrator/planner.js';

test('planner creates stage checklist for research queries', () => {
  const plan = planForQuery('Projede bu endpointi araştır ve karşılaştır');

  assert.ok(Array.isArray(plan.stages));
  assert.ok((plan.stages?.length ?? 0) >= 1);
  assert.ok(plan.stages?.some((stage) => stage.title.includes('Keşif')));
});

test('planner routes trading/OpenBB style queries to openbb_search', () => {
  const plan = planForQuery('Binance için openbb market data ve teknik indikatör analizi yap');

  assert.ok(plan.tools.includes('openbb_search'));
  assert.ok(plan.stages?.some((stage) => stage.tools.includes('openbb_search')));
});

test('planner enables deep reasoning for strategy-heavy prompts', () => {
  const plan = planForQuery('Bu mimariyi trade-offlarıyla karşılaştır, neden bu yönü seçmeliyiz?');

  assert.ok(plan.tools.includes('deep_research'));
  assert.ok((plan.tools.length ?? 0) <= 6);
  assert.match(plan.reasoning, /Poetiq-plan/i);
});

test('planner keeps general writing prompts in direct mode without web search', () => {
  const plan = planForQuery('Bana profesyonel ama samimi bir teşekkür mesajı yaz.');

  assert.deepEqual(plan.tools, []);
  assert.match(plan.reasoning, /Direct answer plan/i);
});

test('planner does not trigger deep research only because prompt has multiple sentences', () => {
  const plan = planForQuery('Dün çok yoruldum. Bana motive edici kısa bir mesaj yaz.');

  assert.equal(plan.tools.includes('deep_research'), false);
  assert.equal(plan.tools.includes('web_search'), false);
});

test('planner adds web search only when freshness or explicit sources are requested', () => {
  const fresh = planForQuery('OpenAI son model release notes özetini kaynaklarıyla ver.');
  const timeless = planForQuery('Soyut sanat nedir, kısa anlat.');

  assert.equal(fresh.tools.includes('web_search'), true);
  assert.equal(timeless.tools.includes('web_search'), false);
});
