import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let deliveryPrivate: {
  resetStoreForTests: () => void;
  setAutoProcessForTests: (enabled?: boolean) => void;
  setLookupForTests: (
    lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>
  ) => void;
};

function authHeaders(token: string, tenantId: string) {
  return {
    authorization: `Bearer ${token}`,
    'x-tenant-id': tenantId,
    'content-type': 'application/json'
  };
}

before(async () => {
  process.env.APP_API_KEYS = '';
  process.env.APP_API_KEY_DEFINITIONS = JSON.stringify([
    { name: 'tenant-admin', key: 'tenant-admin-key', scopes: ['tenant:admin'] },
    { name: 'tenant-read', key: 'tenant-read-key', scopes: ['tenant:read'] }
  ]);
  process.env.KEY_STORE_FILE = `/tmp/smart-ai-test-keys-security-export-delivery-policy-${process.pid}.json`;
  process.env.MODEL_POLICY_FILE = `/tmp/smart-ai-test-model-policy-security-export-delivery-policy-${process.pid}.json`;
  process.env.RAG_REMOTE_POLICY_FILE = `/tmp/smart-ai-test-rag-remote-policy-security-export-delivery-policy-${process.pid}.json`;
  process.env.SECURITY_AUDIT_STORE_FILE = `/tmp/smart-ai-test-security-audit-security-export-delivery-policy-${process.pid}.json`;
  process.env.SECURITY_EXPORT_DELIVERY_STORE_FILE = `/tmp/smart-ai-test-security-export-delivery-policy-deliveries-${process.pid}.json`;
  process.env.SECURITY_EXPORT_DELIVERY_POLICY_FILE = `/tmp/smart-ai-test-security-export-delivery-policy-${process.pid}.json`;
  process.env.SECURITY_EXPORT_DELIVERY_POLICY_DEFAULT_MODE = 'allowlist_only';
  process.env.SECURITY_EXPORT_DELIVERY_POLICY_DEFAULT_ALLOWED_TARGETS =
    'siem.example.com/hooks/audit,https://logs.example.com/v1/tenants';
  process.env.SECURITY_EXPORT_SIGNING_STORE_FILE = `/tmp/smart-ai-test-security-export-signing-delivery-policy-${process.pid}.json`;
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');
  process.env.UI_ALLOWED_ORIGINS = 'https://dashboard.example.com';

  const deliveryModule = await import('../../security/export-delivery.js');
  deliveryPrivate = deliveryModule.__private__;
  deliveryPrivate.setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
  deliveryPrivate.setAutoProcessForTests(false);

  const mod = await import('../../api/app.js');
  app = mod.buildApp();
});

after(async () => {
  deliveryPrivate.setLookupForTests();
  deliveryPrivate.setAutoProcessForTests(true);
  deliveryPrivate.resetStoreForTests();
  await app.close();
});

beforeEach(() => {
  deliveryPrivate.resetStoreForTests();
  deliveryPrivate.setAutoProcessForTests(false);
  deliveryPrivate.setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
});

test('GET /v1/security/export/delivery-policy returns deployment defaults by default', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/security/export/delivery-policy',
    headers: authHeaders('tenant-admin-key', 'tenant-delivery-policy-defaults')
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.object, 'security_export.delivery_policy');
  assert.equal(body.source, 'deployment');
  assert.equal(body.policy_status, 'inherited');
  assert.equal(body.mode, 'allowlist_only');
  assert.deepEqual(body.allowed_targets, ['siem.example.com/hooks/audit', 'logs.example.com/v1/tenants']);
});

test('PUT /v1/security/export/delivery-policy stores tenant target rules and preview returns allow/deny verdicts', async () => {
  const tenantId = 'tenant-delivery-policy-custom';
  const updateRes = await app.inject({
    method: 'PUT',
    url: '/v1/security/export/delivery-policy',
    headers: authHeaders('tenant-admin-key', tenantId),
    payload: {
      mode: 'allowlist_only',
      allowedTargets: ['siem.example.com/hooks/tenant-a', 'https://logs.example.com/v1/tenants/tenant-a']
    }
  });

  assert.equal(updateRes.statusCode, 200);
  const updated = updateRes.json();
  assert.equal(updated.source, 'tenant');
  assert.equal(updated.policy_status, 'active');
  assert.equal(updated.mode, 'allowlist_only');
  assert.deepEqual(updated.allowed_targets, ['siem.example.com/hooks/tenant-a', 'logs.example.com/v1/tenants/tenant-a']);

  const previewAllowedRes = await app.inject({
    method: 'POST',
    url: '/v1/security/export/deliveries/preview',
    headers: authHeaders('tenant-admin-key', tenantId),
    payload: {
      destinationUrl: 'https://siem.example.com/hooks/tenant-a?token=hidden'
    }
  });

  assert.equal(previewAllowedRes.statusCode, 200);
  const allowedBody = previewAllowedRes.json();
  assert.equal(allowedBody.object, 'security_export_delivery_preview');
  assert.equal(allowedBody.allowed, true);
  assert.equal(allowedBody.reason, 'allowlist_match');
  assert.equal(allowedBody.matched_rule, 'siem.example.com/hooks/tenant-a');
  assert.equal(allowedBody.destination.host, 'siem.example.com');
  assert.equal(allowedBody.destination.matched_host_rule, 'siem.example.com/hooks/tenant-a');
  assert.equal(allowedBody.pinned_address, '93.184.216.34');
  assert.ok(!JSON.stringify(allowedBody).includes('hidden'));

  const previewDeniedRes = await app.inject({
    method: 'POST',
    url: '/v1/security/export/deliveries/preview',
    headers: authHeaders('tenant-admin-key', tenantId),
    payload: {
      destinationUrl: 'https://siem.example.com/hooks/tenant-b?token=hidden'
    }
  });

  assert.equal(previewDeniedRes.statusCode, 200);
  const deniedBody = previewDeniedRes.json();
  assert.equal(deniedBody.allowed, false);
  assert.equal(deniedBody.reason, 'path_not_in_allowlist');
  assert.equal(deniedBody.matched_rule, null);
  assert.equal(deniedBody.destination.host, 'siem.example.com');
  assert.equal(deniedBody.destination.matched_host_rule, null);

  const eventsRes = await app.inject({
    method: 'GET',
    url: '/v1/security/events?type=security_export_delivery_previewed&limit=10',
    headers: authHeaders('tenant-admin-key', tenantId)
  });

  assert.equal(eventsRes.statusCode, 200);
  const events = eventsRes.json();
  assert.ok(events.data.some((event: any) => event.type === 'security_export_delivery_previewed'));
});

test('delivery policy can inherit remote-policy allowlist for backward-compatible migration', async () => {
  const tenantId = 'tenant-delivery-policy-inherit';

  const remotePolicyRes = await app.inject({
    method: 'PUT',
    url: '/v1/rag/remote-policy',
    headers: authHeaders('tenant-admin-key', tenantId),
    payload: {
      mode: 'allowlist_only',
      allowedHosts: ['siem.example.com']
    }
  });
  assert.equal(remotePolicyRes.statusCode, 200);

  const deliveryPolicyRes = await app.inject({
    method: 'PUT',
    url: '/v1/security/export/delivery-policy',
    headers: authHeaders('tenant-admin-key', tenantId),
    payload: {
      mode: 'inherit_remote_policy',
      allowedTargets: []
    }
  });
  assert.equal(deliveryPolicyRes.statusCode, 200);

  const previewRes = await app.inject({
    method: 'POST',
    url: '/v1/security/export/deliveries/preview',
    headers: authHeaders('tenant-admin-key', tenantId),
    payload: {
      destinationUrl: 'https://siem.example.com/legacy-hook'
    }
  });

  assert.equal(previewRes.statusCode, 200);
  const preview = previewRes.json();
  assert.equal(preview.allowed, true);
  assert.equal(preview.reason, 'inherit_remote_policy_match');
  assert.equal(preview.matched_rule, 'siem.example.com');
});

test('DELETE /v1/security/export/delivery-policy resets to deployment defaults and emits audit event', async () => {
  const tenantId = 'tenant-delivery-policy-reset';

  const updateRes = await app.inject({
    method: 'PUT',
    url: '/v1/security/export/delivery-policy',
    headers: authHeaders('tenant-admin-key', tenantId),
    payload: {
      mode: 'disabled',
      allowedTargets: []
    }
  });
  assert.equal(updateRes.statusCode, 200);

  const resetRes = await app.inject({
    method: 'DELETE',
    url: '/v1/security/export/delivery-policy',
    headers: {
      authorization: 'Bearer tenant-admin-key',
      'x-tenant-id': tenantId
    }
  });

  assert.equal(resetRes.statusCode, 200);
  const reset = resetRes.json();
  assert.equal(reset.reset, true);
  assert.equal(reset.source, 'deployment');
  assert.equal(reset.mode, 'allowlist_only');
  assert.deepEqual(reset.allowed_targets, ['siem.example.com/hooks/audit', 'logs.example.com/v1/tenants']);

  const eventsRes = await app.inject({
    method: 'GET',
    url: '/v1/security/events?type=security_export_delivery_policy_reset&limit=5',
    headers: authHeaders('tenant-admin-key', tenantId)
  });

  assert.equal(eventsRes.statusCode, 200);
  const events = eventsRes.json();
  assert.ok(events.data.some((event: any) => event.type === 'security_export_delivery_policy_reset'));
});

test('read-only credential cannot update security export delivery policy', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/v1/security/export/delivery-policy',
    headers: authHeaders('tenant-read-key', 'tenant-delivery-policy-readonly'),
    payload: {
      mode: 'allowlist_only',
      allowedTargets: ['siem.example.com/hooks']
    }
  });

  assert.equal(res.statusCode, 403);
  const body = res.json();
  assert.equal(body.error.type, 'permission_error');
  assert.match(body.error.message, /tenant:admin/);
});
