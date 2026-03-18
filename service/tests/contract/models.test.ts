import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

before(async () => {
  process.env.APP_API_KEYS = 'test-api-key';
  process.env.KEY_STORE_FILE = '/tmp/smart-ai-test-keys-models.json';
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');

  const mod = await import('../../api/app.js');
  app = mod.buildApp();
});

after(async () => {
  await app.close();
});

test('GET /v1/models requires auth', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/models' });
  assert.equal(res.statusCode, 401);
});

test('GET /v1/models rejects invalid tenant header format', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': '../tenant-test'
    }
  });

  assert.equal(res.statusCode, 400);
});

test('GET /v1/models returns OpenAI-compatible list', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-test'
    }
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.object, 'list');
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.length >= 1);
});
