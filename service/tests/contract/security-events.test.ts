import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

before(async () => {
  process.env.APP_API_KEYS = '';
  process.env.APP_API_KEY_DEFINITIONS = JSON.stringify([
    { name: 'tenant-admin', key: 'test-admin-key', scopes: ['tenant:admin'] },
    { name: 'tenant-read', key: 'test-read-key', scopes: ['tenant:read'] }
  ]);
  process.env.KEY_STORE_FILE = `/tmp/smart-ai-test-keys-security-events-${process.pid}.json`;
  process.env.MODEL_POLICY_FILE = `/tmp/smart-ai-test-model-policy-security-events-${process.pid}.json`;
  process.env.SECURITY_AUDIT_STORE_FILE = `/tmp/smart-ai-test-security-audit-events-${process.pid}.json`;
  process.env.OPENROUTER_ALLOWED_MODELS = 'deepseek/deepseek-chat-v3.1,openai/gpt-4o-mini';
  process.env.OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-chat-v3.1';
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
      apiKey: 'test-admin-key',
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
      apiKey: 'test-admin-key',
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

test('GET /v1/security/summary returns risk and integrity telemetry', async () => {
  const sessionRes = await app.inject({
    method: 'POST',
    url: '/ui/session',
    payload: {
      apiKey: 'test-admin-key',
      tenantId: 'tenant-security-summary'
    },
    headers: {
      origin: 'https://dashboard.example.com'
    }
  });
  const session = sessionRes.json();

  const deniedRes = await app.inject({
    method: 'POST',
    url: '/v1/mcp/flush',
    headers: {
      authorization: 'Bearer invalid-token',
      'x-tenant-id': 'tenant-security-summary'
    }
  });
  assert.equal(deniedRes.statusCode, 401);

  const summaryRes = await app.inject({
    method: 'GET',
    url: '/v1/security/summary?window_hours=24&top_ip_limit=5',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': 'tenant-security-summary'
    }
  });

  assert.equal(summaryRes.statusCode, 200);
  const body = summaryRes.json();
  assert.equal(body.object, 'security_summary');
  assert.equal(body.tenant_id, 'tenant-security-summary');
  assert.ok(body.totalEvents >= 2);
  assert.ok(body.riskScore >= 1);
  assert.equal(body.integrity.verified, true);
  assert.match(body.integrity.headChainHash, /^[a-f0-9]{64}$/);
});

test('GET /v1/security/export returns admin-only tamper-evident bundle', async () => {
  const sessionRes = await app.inject({
    method: 'POST',
    url: '/ui/session',
    payload: {
      apiKey: 'test-admin-key',
      tenantId: 'tenant-security-export'
    },
    headers: {
      origin: 'https://dashboard.example.com'
    }
  });
  const session = sessionRes.json();

  await app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: {
      authorization: 'Bearer invalid-token',
      'x-tenant-id': 'tenant-security-export'
    }
  });

  const exportRes = await app.inject({
    method: 'GET',
    url: '/v1/security/export?limit=50',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': 'tenant-security-export'
    }
  });

  assert.equal(exportRes.statusCode, 200);
  const body = exportRes.json();
  assert.equal(body.object, 'security_audit_export');
  assert.equal(body.tenant_id, 'tenant-security-export');
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.length >= 2);
  assert.equal(body.integrity.verified, true);
  assert.equal(body.data[0].sequence, 1);
  assert.ok(body.data.every((event: any, index: number, arr: any[]) => index === 0 || event.sequence > arr[index - 1].sequence));
});

test('POST /v1/security/export/verify validates exported bundles and catches tampering', async () => {
  const sessionRes = await app.inject({
    method: 'POST',
    url: '/ui/session',
    payload: {
      apiKey: 'test-admin-key',
      tenantId: 'tenant-security-verify'
    },
    headers: {
      origin: 'https://dashboard.example.com'
    }
  });
  const session = sessionRes.json();

  await app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: {
      authorization: 'Bearer invalid-token',
      'x-tenant-id': 'tenant-security-verify'
    }
  });

  const exportRes = await app.inject({
    method: 'GET',
    url: '/v1/security/export?limit=50',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': 'tenant-security-verify'
    }
  });
  const bundle = exportRes.json();

  const verifyRes = await app.inject({
    method: 'POST',
    url: '/v1/security/export/verify',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': 'tenant-security-verify',
      'content-type': 'application/json',
      origin: 'https://dashboard.example.com'
    },
    payload: {
      anchorPrevChainHash: bundle.integrity.anchorPrevChainHash,
      events: bundle.data
    }
  });

  assert.equal(verifyRes.statusCode, 200);
  const verification = verifyRes.json();
  assert.equal(verification.object, 'security_audit_verification');
  assert.equal(verification.data.verified, true);

  const tampered = structuredClone(bundle.data);
  tampered[tampered.length - 1].details = { reason: 'tampered' };

  const tamperedRes = await app.inject({
    method: 'POST',
    url: '/v1/security/export/verify',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': 'tenant-security-verify',
      'content-type': 'application/json',
      origin: 'https://dashboard.example.com'
    },
    payload: {
      anchorPrevChainHash: bundle.integrity.anchorPrevChainHash,
      events: tampered
    }
  });

  assert.equal(tamperedRes.statusCode, 200);
  const tamperedBody = tamperedRes.json();
  assert.equal(tamperedBody.data.verified, false);
  assert.equal(tamperedBody.data.failureReason, 'chain_hash_mismatch');
});

test('read-only credential can read security summary but cannot access security export', async () => {
  const summaryRes = await app.inject({
    method: 'GET',
    url: '/v1/security/summary?window_hours=24',
    headers: {
      authorization: 'Bearer test-read-key',
      'x-tenant-id': 'tenant-security-read'
    }
  });

  assert.equal(summaryRes.statusCode, 200);

  const exportRes = await app.inject({
    method: 'GET',
    url: '/v1/security/export?limit=10',
    headers: {
      authorization: 'Bearer test-read-key',
      'x-tenant-id': 'tenant-security-read'
    }
  });

  assert.equal(exportRes.statusCode, 403);
});
