import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

function readHeaders(token: string, tenantId = 'tenant-authz', origin = 'https://dashboard.example.com') {
  return {
    authorization: `Bearer ${token}`,
    'x-tenant-id': tenantId,
    origin
  };
}

before(async () => {
  process.env.APP_API_KEYS = '';
  process.env.APP_API_KEY_DEFINITIONS = JSON.stringify([
    {
      name: 'dashboard-ro',
      key: 'dashboard-read-key',
      scopes: ['tenant:read']
    },
    {
      name: 'tenant-ops',
      key: 'tenant-ops-key',
      scopes: ['tenant:read', 'tenant:operate']
    },
    {
      name: 'tenant-admin',
      key: 'tenant-admin-key',
      scopes: ['tenant:admin']
    }
  ]);
  process.env.KEY_STORE_FILE = `/tmp/smart-ai-test-keys-auth-context-${process.pid}.json`;
  process.env.MODEL_POLICY_FILE = `/tmp/smart-ai-test-model-policy-auth-context-${process.pid}.json`;
  process.env.MEMORY_STORE_FILE = `/tmp/smart-ai-test-memory-auth-context-${process.pid}.json`;
  process.env.OPENROUTER_ALLOWED_MODELS = 'deepseek/deepseek-v3.2,openai/gpt-4o-mini';
  process.env.OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-v3.2';
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');
  process.env.UI_SESSION_TTL_SECONDS = '120';
  process.env.UI_SESSION_MAX_IDLE_SECONDS = '120';
  process.env.UI_ALLOWED_ORIGINS = 'https://dashboard.example.com';

  const mod = await import('../../api/app.js');
  app = mod.buildApp();
});

after(async () => {
  await app.close();
});

test('GET /v1/auth/context exposes principal scopes and permissions', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/auth/context',
    headers: {
      authorization: 'Bearer dashboard-read-key',
      'x-tenant-id': 'tenant-authz'
    }
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.principal_name, 'dashboard-ro');
  assert.deepEqual(body.scopes, ['tenant:read']);
  assert.deepEqual(body.permissions, {
    read: true,
    operate: false,
    admin: false
  });
});

test('read-only credential cannot perform operate actions but can read security feed', async () => {
  const denied = await app.inject({
    method: 'POST',
    url: '/v1/memory/items',
    headers: {
      authorization: 'Bearer dashboard-read-key',
      'x-tenant-id': 'tenant-authz',
      'content-type': 'application/json'
    },
    payload: {
      content: 'read only should not ingest memory'
    }
  });

  assert.equal(denied.statusCode, 403);
  const deniedBody = denied.json();
  assert.equal(deniedBody.error.type, 'permission_error');
  assert.match(deniedBody.error.message, /tenant:operate/);

  const events = await app.inject({
    method: 'GET',
    url: '/v1/security/events?type=api_scope_denied&limit=5',
    headers: {
      authorization: 'Bearer dashboard-read-key',
      'x-tenant-id': 'tenant-authz'
    }
  });

  assert.equal(events.statusCode, 200);
  const eventBody = events.json();
  assert.ok(Array.isArray(eventBody.data));
  assert.ok(eventBody.data.some((event: any) => event.type === 'api_scope_denied'));
});

test('operate credential can use tenant write APIs but cannot access admin-only routes', async () => {
  const memoryRes = await app.inject({
    method: 'POST',
    url: '/v1/memory/items',
    headers: {
      authorization: 'Bearer tenant-ops-key',
      'x-tenant-id': 'tenant-authz',
      'content-type': 'application/json'
    },
    payload: {
      content: 'ops credential can store tenant memory'
    }
  });

  assert.equal(memoryRes.statusCode, 200);

  const adminDenied = await app.inject({
    method: 'PUT',
    url: '/v1/model-policy',
    headers: {
      authorization: 'Bearer tenant-ops-key',
      'x-tenant-id': 'tenant-authz',
      'content-type': 'application/json'
    },
    payload: {
      defaultModel: 'deepseek/deepseek-v3.2',
      allowedModels: ['deepseek/deepseek-v3.2'],
      expectedRevision: 0,
      changeReason: 'Operate scope bu admin mutasyonunu yapmamalı.'
    }
  });

  assert.equal(adminDenied.statusCode, 403);
  const body = adminDenied.json();
  assert.match(body.error.message, /tenant:admin/);
});

test('UI session inherits scoped principal and blocks unsafe API calls from disallowed origins', async () => {
  const sessionRes = await app.inject({
    method: 'POST',
    url: '/ui/session',
    headers: {
      origin: 'https://dashboard.example.com'
    },
    payload: {
      apiKey: 'tenant-ops-key',
      tenantId: 'tenant-authz'
    }
  });

  assert.equal(sessionRes.statusCode, 200);
  const sessionBody = sessionRes.json();
  assert.equal(sessionBody.principalName, 'tenant-ops');
  assert.deepEqual(sessionBody.scopes, ['tenant:read', 'tenant:operate']);

  const authContext = await app.inject({
    method: 'GET',
    url: '/v1/auth/context',
    headers: {
      authorization: `Bearer ${sessionBody.token}`,
      'x-tenant-id': 'tenant-authz'
    }
  });

  assert.equal(authContext.statusCode, 200);
  const authBody = authContext.json();
  assert.equal(authBody.auth_mode, 'ui_session');
  assert.equal(authBody.principal_name, 'tenant-ops');
  assert.deepEqual(authBody.scopes, ['tenant:read', 'tenant:operate']);

  const missingOrigin = await app.inject({
    method: 'POST',
    url: '/v1/memory/items',
    headers: {
      authorization: `Bearer ${sessionBody.token}`,
      'x-tenant-id': 'tenant-authz',
      'content-type': 'application/json'
    },
    payload: {
      content: 'missing origin should be rejected'
    }
  });

  assert.equal(missingOrigin.statusCode, 403);

  const badOrigin = await app.inject({
    method: 'POST',
    url: '/v1/memory/items',
    headers: {
      ...readHeaders(sessionBody.token),
      origin: 'https://evil.example.com',
      'content-type': 'application/json'
    },
    payload: {
      content: 'bad origin should be rejected'
    }
  });

  assert.equal(badOrigin.statusCode, 403);

  const allowedOrigin = await app.inject({
    method: 'POST',
    url: '/v1/memory/items',
    headers: {
      ...readHeaders(sessionBody.token),
      'content-type': 'application/json'
    },
    payload: {
      content: 'allowed origin should pass'
    }
  });

  assert.equal(allowedOrigin.statusCode, 200);
});

test('admin credential can manage model policy and protected key routes', async () => {
  const policyRes = await app.inject({
    method: 'PUT',
    url: '/v1/model-policy',
    headers: {
      authorization: 'Bearer tenant-admin-key',
      'x-tenant-id': 'tenant-admin-scope',
      'content-type': 'application/json'
    },
    payload: {
      defaultModel: 'deepseek/deepseek-v3.2',
      allowedModels: ['deepseek/deepseek-v3.2'],
      expectedRevision: 0,
      changeReason: 'Admin credential model policy güncellemesini yapabilmeli.'
    }
  });

  assert.equal(policyRes.statusCode, 200);

  const keyStatus = await app.inject({
    method: 'GET',
    url: '/v1/keys/openrouter/status',
    headers: {
      authorization: 'Bearer tenant-admin-key',
      'x-tenant-id': 'tenant-admin-scope'
    }
  });

  assert.equal(keyStatus.statusCode, 200);
  const body = keyStatus.json();
  assert.equal(body.has_key, false);
});
