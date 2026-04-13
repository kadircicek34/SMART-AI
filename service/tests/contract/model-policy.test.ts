import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

function authHeaders(tenantId = 'tenant-model-policy') {
  return {
    authorization: 'Bearer test-api-key',
    'x-tenant-id': tenantId,
    'content-type': 'application/json'
  };
}

before(async () => {
  process.env.APP_API_KEYS = 'test-api-key';
  process.env.KEY_STORE_FILE = `/tmp/smart-ai-test-keys-model-policy-${process.pid}.json`;
  process.env.MODEL_POLICY_FILE = `/tmp/smart-ai-test-model-policy-contract-${process.pid}.json`;
  process.env.OPENROUTER_ALLOWED_MODELS = 'deepseek/deepseek-chat-v3.1,openai/gpt-4o-mini,google/gemini-2.5-flash';
  process.env.OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-chat-v3.1';
  process.env.OPENROUTER_REASONING_MODELS = 'deepseek/deepseek-chat-v3.1,google/gemini-2.5-flash';
  process.env.OPENROUTER_MAX_TENANT_ALLOWED_MODELS = '2';
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 11).toString('base64');

  const mod = await import('../../api/app.js');
  app = mod.buildApp();
});

after(async () => {
  await app.close();
});

test('GET /v1/model-policy returns deployment defaults, revision metadata and reasoning coverage by default', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/model-policy',
    headers: authHeaders()
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.object, 'model_policy');
  assert.equal(body.source, 'deployment');
  assert.equal(body.policy_status, 'inherited');
  assert.equal(body.default_model, 'deepseek/deepseek-chat-v3.1');
  assert.deepEqual(body.allowed_models, [
    'deepseek/deepseek-chat-v3.1',
    'openai/gpt-4o-mini',
    'google/gemini-2.5-flash'
  ]);
  assert.equal(body.revision, 0);
  assert.equal(body.last_change_kind, 'deployment_default');
  assert.deepEqual(body.reasoning_allowed_models, ['deepseek/deepseek-chat-v3.1', 'google/gemini-2.5-flash']);
});

test('POST /v1/model-policy/preview computes diff, revision and high-risk downgrade warnings before save', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/model-policy/preview',
    headers: authHeaders('tenant-model-policy-preview'),
    payload: {
      defaultModel: 'openai/gpt-4o-mini',
      allowedModels: ['openai/gpt-4o-mini']
    }
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.object, 'model_policy_preview');
  assert.equal(body.current_revision, 0);
  assert.equal(body.next_revision, 1);
  assert.equal(body.change_kind, 'create_override');
  assert.equal(body.diff.default_model_changed, true);
  assert.deepEqual(body.diff.removed_models.sort(), ['deepseek/deepseek-chat-v3.1', 'google/gemini-2.5-flash'].sort());
  assert.equal(body.reasoning.default_model_reasoning_enabled, false);
  assert.equal(body.risk.level, 'high');
  assert.ok(body.risk.reasons.some((reason: string) => /reasoning-capable/i.test(reason)));
});

test('PUT /v1/model-policy narrows tenant model access with change reason + revision guard and /v1/models reflects the effective list', async () => {
  const updateRes = await app.inject({
    method: 'PUT',
    url: '/v1/model-policy',
    headers: authHeaders('tenant-model-policy-custom'),
    payload: {
      defaultModel: 'google/gemini-2.5-flash',
      allowedModels: ['openai/gpt-4o-mini', 'google/gemini-2.5-flash'],
      expectedRevision: 0,
      changeReason: 'Finance tenanti için iki güvenli model ile sınırlandırma yapılıyor.'
    }
  });

  assert.equal(updateRes.statusCode, 200);
  const updated = updateRes.json();
  assert.equal(updated.source, 'tenant');
  assert.equal(updated.policy_status, 'active');
  assert.equal(updated.default_model, 'google/gemini-2.5-flash');
  assert.deepEqual(updated.allowed_models, ['openai/gpt-4o-mini', 'google/gemini-2.5-flash']);
  assert.equal(updated.revision, 1);
  assert.equal(updated.change_reason, 'Finance tenanti için iki güvenli model ile sınırlandırma yapılıyor.');
  assert.equal(updated.last_change_kind, 'override');
  assert.deepEqual(updated.reasoning_allowed_models, ['google/gemini-2.5-flash']);

  const modelsRes = await app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-model-policy-custom'
    }
  });

  assert.equal(modelsRes.statusCode, 200);
  const modelsBody = modelsRes.json();
  assert.deepEqual(
    modelsBody.data.map((item: any) => item.id),
    ['openai/gpt-4o-mini', 'google/gemini-2.5-flash']
  );
  assert.equal(modelsBody.meta.default_model, 'google/gemini-2.5-flash');
  assert.equal(modelsBody.data[1].is_default, true);
});

test('PUT /v1/model-policy rejects stale expectedRevision and returns current revision for conflict handling', async () => {
  const first = await app.inject({
    method: 'PUT',
    url: '/v1/model-policy',
    headers: authHeaders('tenant-model-policy-conflict'),
    payload: {
      defaultModel: 'deepseek/deepseek-chat-v3.1',
      allowedModels: ['deepseek/deepseek-chat-v3.1'],
      expectedRevision: 0,
      changeReason: 'İlk güvenli tenant override yazılıyor.'
    }
  });

  assert.equal(first.statusCode, 200);

  const stale = await app.inject({
    method: 'PUT',
    url: '/v1/model-policy',
    headers: authHeaders('tenant-model-policy-conflict'),
    payload: {
      defaultModel: 'openai/gpt-4o-mini',
      allowedModels: ['openai/gpt-4o-mini'],
      expectedRevision: 0,
      changeReason: 'Stale panel verisi ile ikinci bir değişiklik deneniyor.'
    }
  });

  assert.equal(stale.statusCode, 409);
  const body = stale.json();
  assert.equal(body.error.type, 'invalid_request_error');
  assert.match(body.error.message, /revision mismatch/i);
  assert.equal(body.error.details.current_revision, 1);
});

test('DELETE /v1/model-policy resets tenant policy back to deployment defaults while preserving revision history', async () => {
  const seedRes = await app.inject({
    method: 'PUT',
    url: '/v1/model-policy',
    headers: authHeaders('tenant-model-policy-reset'),
    payload: {
      defaultModel: 'google/gemini-2.5-flash',
      allowedModels: ['google/gemini-2.5-flash'],
      expectedRevision: 0,
      changeReason: 'Tek reasoning model ile geçici tenant override uygulanıyor.'
    }
  });

  assert.equal(seedRes.statusCode, 200);

  const resetRes = await app.inject({
    method: 'DELETE',
    url: '/v1/model-policy',
    headers: authHeaders('tenant-model-policy-reset'),
    payload: {
      expectedRevision: 1,
      changeReason: 'Tenant override kaldırılıyor ve deployment defaultlarına dönülüyor.'
    }
  });

  assert.equal(resetRes.statusCode, 200);
  const body = resetRes.json();
  assert.equal(body.reset, true);
  assert.equal(body.source, 'deployment');
  assert.equal(body.default_model, 'deepseek/deepseek-chat-v3.1');
  assert.equal(body.last_change_kind, 'reset');
  assert.equal(body.revision, 2);
  assert.equal(body.change_reason, 'Tenant override kaldırılıyor ve deployment defaultlarına dönülüyor.');
});
