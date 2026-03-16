import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

before(async () => {
  process.env.APP_API_KEYS = 'test-api-key';
  process.env.KEY_STORE_FILE = '/tmp/smart-ai-test-keys-mcp-health.json';
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 4).toString('base64');

  const mod = await import('../../api/app.js');
  app = mod.buildApp();
});

after(async () => {
  await app.close();
});

test('GET /v1/mcp/health returns aggregated server health', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/mcp/health',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-test'
    }
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'ok');
  assert.ok(body.servers.mevzuat);
  assert.ok(body.servers.borsa);
  assert.ok(body.servers.yargi);
});

test('POST /v1/mcp/reset validates serverId enum', async () => {
  const bad = await app.inject({
    method: 'POST',
    url: '/v1/mcp/reset',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-test',
      'content-type': 'application/json'
    },
    payload: { serverId: 'invalid' }
  });

  assert.equal(bad.statusCode, 400);

  const ok = await app.inject({
    method: 'POST',
    url: '/v1/mcp/reset',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-test',
      'content-type': 'application/json'
    },
    payload: { serverId: 'mevzuat' }
  });

  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().status, 'reset');
});
