import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

before(async () => {
  process.env.APP_API_KEYS = 'test-api-key';
  process.env.KEY_STORE_FILE = '/tmp/smart-ai-test-keys-chat.json';
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
});
