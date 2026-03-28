import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

function authHeaders(token: string, tenantId = 'tenant-remote-policy') {
  return {
    authorization: `Bearer ${token}`,
    'x-tenant-id': tenantId,
    'content-type': 'application/json'
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
      name: 'tenant-admin',
      key: 'tenant-admin-key',
      scopes: ['tenant:admin']
    }
  ]);
  process.env.KEY_STORE_FILE = `/tmp/smart-ai-test-keys-rag-remote-policy-${process.pid}.json`;
  process.env.RAG_REMOTE_POLICY_FILE = `/tmp/smart-ai-test-rag-remote-policy-contract-${process.pid}.json`;
  process.env.RAG_REMOTE_POLICY_DEFAULT_MODE = 'preview_only';
  process.env.RAG_REMOTE_POLICY_DEFAULT_ALLOWED_HOSTS = 'docs.example.com';
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 9).toString('base64');

  const mod = await import('../../api/app.js');
  app = mod.buildApp();
});

after(async () => {
  await app.close();
});

test('GET /v1/rag/remote-policy returns deployment defaults by default', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/rag/remote-policy',
    headers: authHeaders('dashboard-read-key')
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.object, 'rag.remote_policy');
  assert.equal(body.source, 'deployment');
  assert.equal(body.policy_status, 'inherited');
  assert.equal(body.mode, 'preview_only');
  assert.deepEqual(body.allowed_hosts, ['docs.example.com']);
});

test('PUT /v1/rag/remote-policy stores tenant allowlist policy and DELETE resets it', async () => {
  const updateRes = await app.inject({
    method: 'PUT',
    url: '/v1/rag/remote-policy',
    headers: authHeaders('tenant-admin-key', 'tenant-remote-policy-custom'),
    payload: {
      mode: 'allowlist_only',
      allowedHosts: ['example.com', '*.docs.example.com', '93.184.216.34']
    }
  });

  assert.equal(updateRes.statusCode, 200);
  const updated = updateRes.json();
  assert.equal(updated.source, 'tenant');
  assert.equal(updated.policy_status, 'active');
  assert.equal(updated.mode, 'allowlist_only');
  assert.deepEqual(updated.allowed_hosts, ['example.com', '*.docs.example.com', '93.184.216.34']);

  const resetRes = await app.inject({
    method: 'DELETE',
    url: '/v1/rag/remote-policy',
    headers: {
      authorization: 'Bearer tenant-admin-key',
      'x-tenant-id': 'tenant-remote-policy-custom'
    }
  });

  assert.equal(resetRes.statusCode, 200);
  const resetBody = resetRes.json();
  assert.equal(resetBody.reset, true);
  assert.equal(resetBody.source, 'deployment');
  assert.equal(resetBody.mode, 'preview_only');
});

test('read-only credential cannot update remote policy', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/v1/rag/remote-policy',
    headers: authHeaders('dashboard-read-key', 'tenant-remote-policy-denied'),
    payload: {
      mode: 'open',
      allowedHosts: []
    }
  });

  assert.equal(res.statusCode, 403);
  const body = res.json();
  assert.equal(body.error.type, 'permission_error');
  assert.match(body.error.message, /tenant:admin/);
});
