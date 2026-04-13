import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

before(async () => {
  process.env.APP_API_KEYS = 'test-api-key';
  process.env.KEY_STORE_FILE = `/tmp/smart-ai-test-keys-ui-${process.pid}.json`;
  process.env.MODEL_POLICY_FILE = `/tmp/smart-ai-test-model-policy-ui-${process.pid}.json`;
  process.env.OPENROUTER_ALLOWED_MODELS = 'deepseek/deepseek-v3.2,openai/gpt-4o-mini';
  process.env.OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-v3.2';
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 6).toString('base64');
  process.env.UI_SESSION_TTL_SECONDS = '120';
  process.env.UI_SESSION_MAX_IDLE_SECONDS = '120';
  process.env.UI_SESSION_MAX_SESSIONS_PER_TENANT = '5';
  process.env.UI_SESSION_MAX_SESSIONS_GLOBAL = '500';
  process.env.UI_ALLOWED_ORIGINS = 'https://dashboard.example.com';

  const mod = await import('../../api/app.js');
  app = mod.buildApp();
});

after(async () => {
  await app.close();
});

test('GET /ui/dashboard serves control dashboard HTML with security headers', async () => {
  const res = await app.inject({ method: 'GET', url: '/ui/dashboard' });

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /text\/html/);
  assert.match(res.body, /SMART-AI Control Dashboard/);
  assert.match(res.body, /Policy Önizle/);
  assert.match(res.body, /revision guard \+ zorunlu change reason/);
  assert.match(String(res.headers['content-security-policy'] ?? ''), /default-src 'self'/);
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('GET /ui/chat serves chatbot UI HTML', async () => {
  const res = await app.inject({ method: 'GET', url: '/ui/chat' });

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /text\/html/);
  assert.match(res.body, /SMART-AI Chat UI/);
});

test('GET /ui/assets/app.css serves static css asset', async () => {
  const res = await app.inject({ method: 'GET', url: '/ui/assets/app.css' });

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /text\/css/);
  assert.match(res.body, /:root/);
});

test('GET /ui/assets path traversal is blocked', async () => {
  const res = await app.inject({ method: 'GET', url: '/ui/assets/..%2F..%2Fserver.ts' });

  assert.equal(res.statusCode, 404);
});

test('POST /ui/session issues short-lived token and token can call /v1/models', async () => {
  const sessionRes = await app.inject({
    method: 'POST',
    url: '/ui/session',
    payload: {
      apiKey: 'test-api-key',
      tenantId: 'tenant-ui'
    }
  });

  assert.equal(sessionRes.statusCode, 200);
  const sessionBody = sessionRes.json();
  assert.equal(typeof sessionBody.token, 'string');
  assert.equal(sessionBody.tenantId, 'tenant-ui');

  const modelsRes = await app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: {
      authorization: `Bearer ${sessionBody.token}`,
      'x-tenant-id': 'tenant-ui'
    }
  });

  assert.equal(modelsRes.statusCode, 200);
});

test('GET /ui/session returns current session metadata', async () => {
  const sessionRes = await app.inject({
    method: 'POST',
    url: '/ui/session',
    payload: {
      apiKey: 'test-api-key',
      tenantId: 'tenant-meta'
    }
  });

  assert.equal(sessionRes.statusCode, 200);
  const sessionBody = sessionRes.json();

  const metaRes = await app.inject({
    method: 'GET',
    url: '/ui/session',
    headers: {
      authorization: `Bearer ${sessionBody.token}`,
      'x-tenant-id': 'tenant-meta'
    }
  });

  assert.equal(metaRes.statusCode, 200);
  const metaBody = metaRes.json();
  assert.equal(metaBody.tenantId, 'tenant-meta');
  assert.equal(metaBody.token, undefined);
  assert.equal(typeof metaBody.expiresAt, 'string');
  assert.equal(typeof metaBody.lastSeenAt, 'string');
  assert.ok(metaBody.expiresInSeconds > 0);
  assert.ok(metaBody.idleTimeoutSeconds >= 60);
});

test('POST /ui/session/refresh rotates token and invalidates old one', async () => {
  const sessionRes = await app.inject({
    method: 'POST',
    url: '/ui/session',
    payload: {
      apiKey: 'test-api-key',
      tenantId: 'tenant-refresh'
    }
  });

  const sessionBody = sessionRes.json();

  const refreshRes = await app.inject({
    method: 'POST',
    url: '/ui/session/refresh',
    headers: {
      authorization: `Bearer ${sessionBody.token}`,
      'x-tenant-id': 'tenant-refresh'
    }
  });

  assert.equal(refreshRes.statusCode, 200);
  const refreshBody = refreshRes.json();
  assert.equal(typeof refreshBody.token, 'string');
  assert.notEqual(refreshBody.token, sessionBody.token);

  const oldTokenRes = await app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: {
      authorization: `Bearer ${sessionBody.token}`,
      'x-tenant-id': 'tenant-refresh'
    }
  });
  assert.equal(oldTokenRes.statusCode, 401);

  const newTokenRes = await app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: {
      authorization: `Bearer ${refreshBody.token}`,
      'x-tenant-id': 'tenant-refresh'
    }
  });
  assert.equal(newTokenRes.statusCode, 200);
});

test('UI session token is tenant scoped', async () => {
  const sessionRes = await app.inject({
    method: 'POST',
    url: '/ui/session',
    payload: {
      apiKey: 'test-api-key',
      tenantId: 'tenant-a'
    }
  });

  const sessionBody = sessionRes.json();

  const wrongTenantRes = await app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: {
      authorization: `Bearer ${sessionBody.token}`,
      'x-tenant-id': 'tenant-b'
    }
  });

  assert.equal(wrongTenantRes.statusCode, 403);
});

test('POST /ui/session/revoke invalidates issued token', async () => {
  const sessionRes = await app.inject({
    method: 'POST',
    url: '/ui/session',
    payload: {
      apiKey: 'test-api-key',
      tenantId: 'tenant-revoke'
    }
  });

  const sessionBody = sessionRes.json();

  const revokeRes = await app.inject({
    method: 'POST',
    url: '/ui/session/revoke',
    headers: {
      authorization: `Bearer ${sessionBody.token}`,
      'x-tenant-id': 'tenant-revoke'
    }
  });

  assert.equal(revokeRes.statusCode, 200);

  const modelsRes = await app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: {
      authorization: `Bearer ${sessionBody.token}`,
      'x-tenant-id': 'tenant-revoke'
    }
  });

  assert.equal(modelsRes.statusCode, 401);
});

test('POST /ui/session brute-force attempts trigger temporary 429 lock', async () => {
  for (let i = 0; i < 5; i += 1) {
    const attempt = await app.inject({
      method: 'POST',
      url: '/ui/session',
      payload: {
        apiKey: `wrong-key-${i}`,
        tenantId: 'tenant-lock'
      },
      remoteAddress: '10.0.0.9'
    });

    assert.equal(attempt.statusCode, 401);
  }

  const blocked = await app.inject({
    method: 'POST',
    url: '/ui/session',
    payload: {
      apiKey: 'test-api-key',
      tenantId: 'tenant-lock'
    },
    remoteAddress: '10.0.0.9'
  });

  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.headers['retry-after']) >= 1);
});

test('POST /ui/session rejects invalid tenant id format', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/ui/session',
    payload: {
      apiKey: 'test-api-key',
      tenantId: '../tenant'
    }
  });

  assert.equal(res.statusCode, 400);
});

test('POST /ui/session blocks origin not in allowlist', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/ui/session',
    payload: {
      apiKey: 'test-api-key',
      tenantId: 'tenant-origin'
    },
    headers: {
      origin: 'https://evil.example.com'
    }
  });

  assert.equal(res.statusCode, 403);
});

test('POST /ui/session accepts allowlisted origin', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/ui/session',
    payload: {
      apiKey: 'test-api-key',
      tenantId: 'tenant-origin-ok'
    },
    headers: {
      origin: 'https://dashboard.example.com'
    }
  });

  assert.equal(res.statusCode, 200);
});
