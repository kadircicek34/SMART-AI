import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

before(async () => {
  process.env.APP_API_KEYS = 'test-api-key';
  process.env.KEY_STORE_FILE = '/tmp/smart-ai-test-keys-security-events.json';
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 2).toString('base64');
  process.env.UI_ALLOWED_ORIGINS = 'https://dashboard.example.com';

  const mod = await import('../../api/app.js');
  app = mod.buildApp();
});

after(async () => {
  await app.close();
});

test('GET /v1/security/events returns tenant-scoped event feed', async () => {
  const sessionRes = await app.inject({
    method: 'POST',
    url: '/ui/session',
    payload: {
      apiKey: 'test-api-key',
      tenantId: 'tenant-security'
    },
    headers: {
      origin: 'https://dashboard.example.com'
    }
  });

  assert.equal(sessionRes.statusCode, 200);
  const session = sessionRes.json();

  const authFailRes = await app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: {
      authorization: 'Bearer invalid-token',
      'x-tenant-id': 'tenant-security'
    }
  });
  assert.equal(authFailRes.statusCode, 401);

  const eventsRes = await app.inject({
    method: 'GET',
    url: '/v1/security/events?limit=10',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': 'tenant-security'
    }
  });

  assert.equal(eventsRes.statusCode, 200);
  const body = eventsRes.json();
  assert.equal(body.object, 'list');
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.some((event: any) => event.type === 'ui_session_issued'));
  assert.ok(body.data.some((event: any) => event.type === 'api_auth_failed'));
});

test('GET /v1/security/events supports type filter', async () => {
  const sessionRes = await app.inject({
    method: 'POST',
    url: '/ui/session',
    payload: {
      apiKey: 'test-api-key',
      tenantId: 'tenant-security-filter'
    },
    headers: {
      origin: 'https://dashboard.example.com'
    }
  });
  const session = sessionRes.json();

  const eventsRes = await app.inject({
    method: 'GET',
    url: '/v1/security/events?type=ui_session_issued&limit=5',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': 'tenant-security-filter'
    }
  });

  assert.equal(eventsRes.statusCode, 200);
  const body = eventsRes.json();
  assert.ok(body.data.length >= 1);
  assert.ok(body.data.every((event: any) => event.type === 'ui_session_issued'));
});
