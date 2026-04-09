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
  process.env.OPENROUTER_ALLOWED_MODELS = 'deepseek/deepseek-v3.2,openai/gpt-4o-mini,google/gemini-2.5-flash';
  process.env.OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-v3.2';
  process.env.OPENROUTER_MAX_TENANT_ALLOWED_MODELS = '2';
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 11).toString('base64');

  const mod = await import('../../api/app.js');
  app = mod.buildApp();
});

after(async () => {
  await app.close();
});

test('GET /v1/model-policy returns deployment defaults by default', async () => {
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
  assert.equal(body.default_model, 'deepseek/deepseek-v3.2');
  assert.deepEqual(body.allowed_models, [
    'deepseek/deepseek-v3.2',
    'openai/gpt-4o-mini',
    'google/gemini-2.5-flash'
  ]);
});

test('PUT /v1/model-policy narrows tenant model access and /v1/models reflects the effective list', async () => {
  const updateRes = await app.inject({
    method: 'PUT',
    url: '/v1/model-policy',
    headers: authHeaders('tenant-model-policy-custom'),
    payload: {
      defaultModel: 'openai/gpt-4o-mini',
      allowedModels: ['openai/gpt-4o-mini', 'google/gemini-2.5-flash']
    }
  });

  assert.equal(updateRes.statusCode, 200);
  const updated = updateRes.json();
  assert.equal(updated.source, 'tenant');
  assert.equal(updated.policy_status, 'active');
  assert.equal(updated.default_model, 'openai/gpt-4o-mini');
  assert.deepEqual(updated.allowed_models, ['openai/gpt-4o-mini', 'google/gemini-2.5-flash']);

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
  assert.equal(modelsBody.meta.default_model, 'openai/gpt-4o-mini');
  assert.equal(modelsBody.data[0].is_default, true);
});

test('PUT /v1/model-policy rejects model outside deployment allowlist', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/v1/model-policy',
    headers: authHeaders('tenant-model-policy-reject'),
    payload: {
      defaultModel: 'anthropic/claude-3.7-sonnet',
      allowedModels: ['anthropic/claude-3.7-sonnet']
    }
  });

  assert.equal(res.statusCode, 403);
  const body = res.json();
  assert.equal(body.error.type, 'permission_error');
});

test('DELETE /v1/model-policy resets tenant policy back to deployment defaults', async () => {
  const seedRes = await app.inject({
    method: 'PUT',
    url: '/v1/model-policy',
    headers: authHeaders('tenant-model-policy-reset'),
    payload: {
      defaultModel: 'google/gemini-2.5-flash',
      allowedModels: ['google/gemini-2.5-flash']
    }
  });

  assert.equal(seedRes.statusCode, 200);

  const resetRes = await app.inject({
    method: 'DELETE',
    url: '/v1/model-policy',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-model-policy-reset'
    }
  });

  assert.equal(resetRes.statusCode, 200);
  const body = resetRes.json();
  assert.equal(body.reset, true);
  assert.equal(body.source, 'deployment');
  assert.equal(body.default_model, 'deepseek/deepseek-v3.2');
});
