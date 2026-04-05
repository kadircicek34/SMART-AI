import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

function authHeaders(token: string, tenantId: string) {
  return {
    authorization: `Bearer ${token}`,
    'x-tenant-id': tenantId,
    'content-type': 'application/json',
    origin: 'https://dashboard.example.com'
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

before(async () => {
  process.env.APP_API_KEYS = '';
  process.env.APP_API_KEY_DEFINITIONS = JSON.stringify([
    { name: 'tenant-admin', key: 'signing-admin-key', scopes: ['tenant:admin'] },
    { name: 'tenant-read', key: 'signing-read-key', scopes: ['tenant:read'] }
  ]);
  process.env.KEY_STORE_FILE = `/tmp/smart-ai-test-keys-security-export-signing-policy-${process.pid}.json`;
  process.env.MODEL_POLICY_FILE = `/tmp/smart-ai-test-model-policy-security-export-signing-policy-${process.pid}.json`;
  process.env.SECURITY_AUDIT_STORE_FILE = `/tmp/smart-ai-test-security-audit-signing-policy-${process.pid}.json`;
  process.env.SECURITY_EXPORT_SIGNING_STORE_FILE = `/tmp/smart-ai-test-security-export-signing-policy-${process.pid}.json`;
  process.env.SECURITY_EXPORT_SIGNING_MAX_VERIFY_KEYS = '3';
  process.env.SECURITY_EXPORT_SIGNING_AUTO_ROTATE_ENABLED = 'true';
  process.env.SECURITY_EXPORT_SIGNING_ROTATE_AFTER_HOURS = '720';
  process.env.SECURITY_EXPORT_SIGNING_EXPIRE_AFTER_HOURS = '1080';
  process.env.SECURITY_EXPORT_SIGNING_WARN_BEFORE_HOURS = '168';
  process.env.SECURITY_EXPORT_SIGNING_VERIFY_RETENTION_HOURS = '2160';
  process.env.SECURITY_EXPORT_SIGNING_MAINTENANCE_INTERVAL_MS = '0';
  process.env.SECURITY_EXPORT_SIGNING_MAINTENANCE_LEASE_TTL_MS = '60000';
  process.env.SECURITY_EXPORT_SIGNING_MAINTENANCE_HISTORY_LIMIT = '12';
  process.env.OPENROUTER_ALLOWED_MODELS = 'deepseek/deepseek-chat-v3.1,openai/gpt-4o-mini';
  process.env.OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-chat-v3.1';
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 6).toString('base64');
  process.env.UI_ALLOWED_ORIGINS = 'https://dashboard.example.com';

  const mod = await import('../../api/app.js');
  app = mod.buildApp();
});

after(async () => {
  await app.close();
});

test('GET/PUT /v1/security/export/signing-policy exposes lifecycle policy and keys payload includes lifecycle metadata', async () => {
  const tenantId = 'tenant-signing-policy';

  const getRes = await app.inject({
    method: 'GET',
    url: '/v1/security/export/signing-policy',
    headers: authHeaders('signing-admin-key', tenantId)
  });

  assert.equal(getRes.statusCode, 200);
  const initial = getRes.json();
  assert.equal(initial.object, 'security_export_signing_policy');
  assert.equal(initial.data.auto_rotate, true);
  assert.equal(initial.lifecycle.object, 'security_export_signing_lifecycle');
  assert.match(initial.lifecycle.active_key_id, /^sexp_/);
  assert.equal(initial.maintenance.object, 'security_export_signing_maintenance');
  assert.equal(initial.maintenance.revision >= 1, true);

  const updateRes = await app.inject({
    method: 'PUT',
    url: '/v1/security/export/signing-policy',
    headers: authHeaders('signing-admin-key', tenantId),
    payload: {
      auto_rotate: true,
      rotate_after_hours: 24,
      expire_after_hours: 72,
      warn_before_hours: 12,
      verify_retention_hours: 240
    }
  });

  assert.equal(updateRes.statusCode, 200);
  const updated = updateRes.json();
  assert.equal(updated.updated, true);
  assert.equal(updated.data.rotate_after_hours, 24);
  assert.equal(updated.data.expire_after_hours, 72);
  assert.equal(updated.data.verify_retention_hours, 240);
  assert.equal(updated.lifecycle.policy.rotate_after_hours, 24);

  const keysRes = await app.inject({
    method: 'GET',
    url: '/v1/security/export/keys',
    headers: authHeaders('signing-admin-key', tenantId)
  });

  assert.equal(keysRes.statusCode, 200);
  const keys = keysRes.json();
  assert.equal(keys.object, 'security_export_signing_keys');
  assert.equal(keys.policy.rotate_after_hours, 24);
  assert.equal(keys.lifecycle.policy.verify_retention_hours, 240);
  assert.equal(keys.lifecycle.status, 'healthy');
  assert.equal(keys.maintenance.object, 'security_export_signing_maintenance');
  assert.ok(Array.isArray(keys.data));
  assert.equal(keys.data.length, 1);
  assert.match(keys.data[0].lifecycle.expires_at, /T/);
});

test('POST /v1/security/export/signing-maintenance/run supports dry-run preview and manual maintenance execution', async () => {
  const tenantId = 'tenant-signing-maintenance';

  const policyRes = await app.inject({
    method: 'PUT',
    url: '/v1/security/export/signing-policy',
    headers: authHeaders('signing-admin-key', tenantId),
    payload: {
      auto_rotate: true,
      rotate_after_hours: 0.0001,
      expire_after_hours: 0.001,
      warn_before_hours: 0.0005,
      verify_retention_hours: 24
    }
  });

  assert.equal(policyRes.statusCode, 200);
  const beforeActiveKeyId = policyRes.json().lifecycle.active_key_id;
  await sleep(1200);

  const dryRunRes = await app.inject({
    method: 'POST',
    url: '/v1/security/export/signing-maintenance/run',
    headers: authHeaders('signing-admin-key', tenantId),
    payload: {
      dry_run: true
    }
  });

  assert.equal(dryRunRes.statusCode, 200);
  const dryRun = dryRunRes.json();
  assert.equal(dryRun.object, 'security_export_signing_maintenance');
  assert.equal(dryRun.data.dry_run, true);
  assert.equal(dryRun.data.skipped_reason, 'dry_run');
  assert.ok(dryRun.data.actions.includes('rotate_due_active_key'));

  const executeRes = await app.inject({
    method: 'POST',
    url: '/v1/security/export/signing-maintenance/run',
    headers: authHeaders('signing-admin-key', tenantId),
    payload: {}
  });

  assert.equal(executeRes.statusCode, 200);
  const executed = executeRes.json();
  assert.equal(executed.data.changed, true);
  assert.equal(executed.data.rotation_performed, true);
  assert.notEqual(executed.lifecycle.active_key_id, beforeActiveKeyId);
  assert.equal(executed.maintenance.last_run.run_id, executed.data.run_id);
  assert.ok(Array.isArray(executed.maintenance.history));
  assert.equal(executed.maintenance.history[0].run_id, executed.data.run_id);

  const getRes = await app.inject({
    method: 'GET',
    url: '/v1/security/export/signing-maintenance',
    headers: authHeaders('signing-admin-key', tenantId)
  });

  assert.equal(getRes.statusCode, 200);
  const maintenance = getRes.json();
  assert.equal(maintenance.data.object, 'security_export_signing_maintenance');
  assert.equal(maintenance.data.last_run.run_id, executed.data.run_id);
  assert.equal(maintenance.data.history[0].run_id, executed.data.run_id);
});

test('security export auto-rotates overdue signing keys before export when lifecycle policy becomes due', async () => {
  const tenantId = 'tenant-signing-auto-rotate';

  const initialKeysRes = await app.inject({
    method: 'GET',
    url: '/v1/security/export/keys',
    headers: authHeaders('signing-admin-key', tenantId)
  });
  const initialKeys = initialKeysRes.json();
  const initialActiveKeyId = initialKeys.active_key_id;

  const policyRes = await app.inject({
    method: 'PUT',
    url: '/v1/security/export/signing-policy',
    headers: authHeaders('signing-admin-key', tenantId),
    payload: {
      auto_rotate: true,
      rotate_after_hours: 0.0001,
      expire_after_hours: 0.001,
      warn_before_hours: 0.0005,
      verify_retention_hours: 24
    }
  });

  assert.equal(policyRes.statusCode, 200);
  await sleep(1200);

  const exportRes = await app.inject({
    method: 'GET',
    url: '/v1/security/export?limit=10',
    headers: authHeaders('signing-admin-key', tenantId)
  });

  assert.equal(exportRes.statusCode, 200);
  const bundle = exportRes.json();
  assert.equal(bundle.object, 'security_audit_export');
  assert.match(bundle.signature.key_id, /^sexp_/);

  const nextKeysRes = await app.inject({
    method: 'GET',
    url: '/v1/security/export/keys',
    headers: authHeaders('signing-admin-key', tenantId)
  });
  assert.equal(nextKeysRes.statusCode, 200);
  const nextKeys = nextKeysRes.json();

  assert.notEqual(nextKeys.active_key_id, initialActiveKeyId);
  assert.equal(bundle.signature.key_id, nextKeys.active_key_id);
  assert.equal(nextKeys.data.filter((entry: any) => entry.status === 'active').length, 1);
  assert.equal(nextKeys.data.some((entry: any) => entry.key_id === initialActiveKeyId && entry.status === 'verify_only'), true);
});

test('read-only credential cannot update signing lifecycle policy', async () => {
  const response = await app.inject({
    method: 'PUT',
    url: '/v1/security/export/signing-policy',
    headers: authHeaders('signing-read-key', 'tenant-signing-readonly'),
    payload: {
      auto_rotate: true,
      rotate_after_hours: 24,
      expire_after_hours: 72,
      warn_before_hours: 12,
      verify_retention_hours: 240
    }
  });

  assert.equal(response.statusCode, 403);
});
