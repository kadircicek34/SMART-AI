import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

before(async () => {
  process.env.APP_API_KEYS = 'test-api-key';
  process.env.KEY_STORE_FILE = `/tmp/smart-ai-test-keys-chat-${process.pid}.json`;
  process.env.MODEL_POLICY_FILE = `/tmp/smart-ai-test-model-policy-chat-${process.pid}.json`;
  process.env.OPENROUTER_ALLOWED_MODELS = 'deepseek/deepseek-chat-v3.1,openai/gpt-4o-mini';
  process.env.OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-chat-v3.1';
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 9).toString('base64');

  const mod = await import('../../api/app.js');
  app = mod.buildApp();
});

after(async () => {
  await app.close();
});

test('POST /v1/chat/completions rejects invalid body', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-test',
      'content-type': 'application/json'
    },
    payload: { model: 'x' }
  });

  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error.type, 'invalid_request_error');
});

test('POST /v1/chat/completions rejects model outside allowlist', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-test',
      'content-type': 'application/json'
    },
    payload: {
      model: 'openrouter/agentic-default',
      messages: [{ role: 'user', content: 'selam' }]
    }
  });

  assert.equal(res.statusCode, 403);
  const body = res.json();
  assert.equal(body.error.type, 'permission_error');
});

test('POST /v1/chat/completions uses tenant default model when request omits model', async () => {
  const policyRes = await app.inject({
    method: 'PUT',
    url: '/v1/model-policy',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-default-model',
      'content-type': 'application/json'
    },
    payload: {
      defaultModel: 'openai/gpt-4o-mini',
      allowedModels: ['openai/gpt-4o-mini']
    }
  });

  assert.equal(policyRes.statusCode, 200);

  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-default-model',
      'content-type': 'application/json'
    },
    payload: {
      messages: [{ role: 'user', content: 'hava nasıl' }]
    }
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.metadata.selected_model, 'openai/gpt-4o-mini');
  assert.equal(body.metadata.used_default_model, true);
  assert.equal(body.metadata.model_policy_source, 'tenant');
});

test('POST /v1/chat/completions returns completion shape', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-test',
      'content-type': 'application/json'
    },
    payload: {
      model: 'deepseek/deepseek-chat-v3.1',
      messages: [{ role: 'user', content: 'selam' }]
    }
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.object, 'chat.completion');
  assert.ok(Array.isArray(body.choices));
  assert.equal(body.choices[0].message.role, 'assistant');
  assert.ok(typeof body.choices[0].message.content === 'string');
  assert.ok(typeof body.usage.total_tokens === 'number');
  assert.ok(typeof body.metadata.verification.simplicity_score === 'number');
  assert.ok(typeof body.metadata.verification.evidence_confidence === 'number');
});
