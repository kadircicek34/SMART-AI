import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let uiSessionStoreFile: string;
let securityAuditStoreFile: string;

function tempFile(name: string): string {
  return path.join(os.tmpdir(), `smart-ai-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
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
      name: 'tenant-admin',
      key: 'tenant-admin-key',
      scopes: ['tenant:admin']
    }
  ]);
  process.env.KEY_STORE_FILE = tempFile('keys-ui-sessions');
  process.env.MODEL_POLICY_FILE = tempFile('model-policy-ui-sessions');
  uiSessionStoreFile = tempFile('ui-sessions-contract');
  securityAuditStoreFile = tempFile('security-audit-contract');
  process.env.UI_SESSION_STORE_FILE = uiSessionStoreFile;
  process.env.SECURITY_AUDIT_STORE_FILE = securityAuditStoreFile;
  process.env.OPENROUTER_ALLOWED_MODELS = 'deepseek/deepseek-chat-v3.1,openai/gpt-4o-mini';
  process.env.OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-chat-v3.1';
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 11).toString('base64');
  process.env.UI_SESSION_TTL_SECONDS = '120';
  process.env.UI_SESSION_MAX_IDLE_SECONDS = '120';
  process.env.UI_ALLOWED_ORIGINS = 'https://dashboard.example.com';

  const mod = await import('../../api/app.js');
  app = mod.buildApp();
});

after(async () => {
  await app.close();
  await fs.rm(uiSessionStoreFile, { force: true });
  await fs.rm(securityAuditStoreFile, { force: true });
});

async function issueAdminSession(tenantId: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/ui/session',
    headers: {
      origin: 'https://dashboard.example.com'
    },
    payload: {
      apiKey: 'tenant-admin-key',
      tenantId
    }
  });

  assert.equal(res.statusCode, 200);
  return res.json();
}

test('admin UI session can list active sessions and revoke a targeted session', async () => {
  const current = await issueAdminSession('tenant-ui-admin');
  const target = await issueAdminSession('tenant-ui-admin');

  const listRes = await app.inject({
    method: 'GET',
    url: '/v1/ui/sessions?limit=10',
    headers: {
      authorization: `Bearer ${current.token}`,
      'x-tenant-id': 'tenant-ui-admin'
    }
  });

  assert.equal(listRes.statusCode, 200);
  const listBody = listRes.json();
  assert.equal(listBody.object, 'list');
  assert.ok(Array.isArray(listBody.data));
  assert.equal(listBody.data.length, 2);
  assert.equal(listBody.data.filter((session: any) => session.is_current).length, 1);
  assert.ok(listBody.data.some((session: any) => session.session_id === target.sessionId));

  const revokeRes = await app.inject({
    method: 'POST',
    url: `/v1/ui/sessions/${target.sessionId}/revoke`,
    headers: {
      authorization: `Bearer ${current.token}`,
      'x-tenant-id': 'tenant-ui-admin',
      origin: 'https://dashboard.example.com'
    }
  });

  assert.equal(revokeRes.statusCode, 200);
  const revokeBody = revokeRes.json();
  assert.equal(revokeBody.revoked, true);
  assert.equal(revokeBody.session_id, target.sessionId);

  const targetUseRes = await app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: {
      authorization: `Bearer ${target.token}`,
      'x-tenant-id': 'tenant-ui-admin'
    }
  });

  assert.equal(targetUseRes.statusCode, 401);
});

test('admin UI session revoke-all can keep current session alive', async () => {
  const current = await issueAdminSession('tenant-ui-bulk');
  const targetA = await issueAdminSession('tenant-ui-bulk');
  const targetB = await issueAdminSession('tenant-ui-bulk');

  const revokeAllRes = await app.inject({
    method: 'POST',
    url: '/v1/ui/sessions/revoke-all',
    headers: {
      authorization: `Bearer ${current.token}`,
      'x-tenant-id': 'tenant-ui-bulk',
      origin: 'https://dashboard.example.com',
      'content-type': 'application/json'
    },
    payload: {
      exceptCurrent: true
    }
  });

  assert.equal(revokeAllRes.statusCode, 200);
  const revokeAllBody = revokeAllRes.json();
  assert.equal(revokeAllBody.revoked_count, 2);
  assert.equal(revokeAllBody.except_current, true);

  const currentRes = await app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: {
      authorization: `Bearer ${current.token}`,
      'x-tenant-id': 'tenant-ui-bulk'
    }
  });
  assert.equal(currentRes.statusCode, 200);

  const revokedA = await app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: {
      authorization: `Bearer ${targetA.token}`,
      'x-tenant-id': 'tenant-ui-bulk'
    }
  });
  const revokedB = await app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: {
      authorization: `Bearer ${targetB.token}`,
      'x-tenant-id': 'tenant-ui-bulk'
    }
  });

  assert.equal(revokedA.statusCode, 401);
  assert.equal(revokedB.statusCode, 401);
});

test('read-only credential cannot access admin UI session management API', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/ui/sessions',
    headers: {
      authorization: 'Bearer dashboard-read-key',
      'x-tenant-id': 'tenant-ui-readonly'
    }
  });

  assert.equal(res.statusCode, 403);
  const body = res.json();
  assert.equal(body.error.type, 'permission_error');
  assert.match(body.error.message, /tenant:admin/);
});
