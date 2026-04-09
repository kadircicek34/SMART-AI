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
    { name: 'tenant-read', key: 'tenant-read-key', scopes: ['tenant:read'] },
    { name: 'incident-commander', key: 'incident-commander-key', scopes: ['tenant:admin'] },
    { name: 'recovery-requester', key: 'recovery-requester-key', scopes: ['tenant:admin'] },
    { name: 'recovery-approver', key: 'recovery-approver-key', scopes: ['tenant:admin'] }
  ]);
  process.env.KEY_STORE_FILE = `/tmp/smart-ai-test-keys-security-export-operator-policy-${process.pid}.json`;
  process.env.MODEL_POLICY_FILE = `/tmp/smart-ai-test-model-policy-security-export-operator-policy-${process.pid}.json`;
  process.env.RAG_REMOTE_POLICY_FILE = `/tmp/smart-ai-test-rag-remote-policy-security-export-operator-policy-${process.pid}.json`;
  process.env.SECURITY_AUDIT_STORE_FILE = `/tmp/smart-ai-test-security-audit-security-export-operator-policy-${process.pid}.json`;
  process.env.SECURITY_EXPORT_DELIVERY_STORE_FILE = `/tmp/smart-ai-test-security-export-operator-policy-deliveries-${process.pid}.json`;
  process.env.SECURITY_EXPORT_DELIVERY_POLICY_FILE = `/tmp/smart-ai-test-security-export-delivery-policy-operator-policy-${process.pid}.json`;
  process.env.SECURITY_EXPORT_OPERATOR_POLICY_FILE = `/tmp/smart-ai-test-security-export-operator-policy-${process.pid}.json`;
  process.env.SECURITY_EXPORT_OPERATOR_POLICY_DEFAULT_MODE = 'open_admins';
  process.env.SECURITY_EXPORT_SIGNING_STORE_FILE = `/tmp/smart-ai-test-security-export-signing-operator-policy-${process.pid}.json`;
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 8).toString('base64');
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

test('GET /v1/security/export/operator-policy returns deployment defaults by default', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/security/export/operator-policy',
    headers: authHeaders('tenant-admin-key', 'tenant-operator-policy-defaults')
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.object, 'security_export.operator_policy');
  assert.equal(body.source, 'deployment');
  assert.equal(body.policy_status, 'inherited');
  assert.equal(body.mode, 'open_admins');
  assert.deepEqual(body.roster, {
    acknowledge: [],
    clear_request: [],
    clear_approve: []
  });
});

test('PUT /v1/security/export/operator-policy stores explicit incident roles and emits audit event', async () => {
  const tenantId = 'tenant-operator-policy-custom';
  const updateRes = await app.inject({
    method: 'PUT',
    url: '/v1/security/export/operator-policy',
    headers: authHeaders('tenant-admin-key', tenantId),
    payload: {
      mode: 'roster_required',
      roster: {
        acknowledge: ['incident-commander'],
        clear_request: ['recovery-requester'],
        clear_approve: ['recovery-approver']
      }
    }
  });

  assert.equal(updateRes.statusCode, 200);
  const body = updateRes.json();
  assert.equal(body.source, 'tenant');
  assert.equal(body.policy_status, 'active');
  assert.equal(body.mode, 'roster_required');
  assert.deepEqual(body.roster, {
    acknowledge: ['incident-commander'],
    clear_request: ['recovery-requester'],
    clear_approve: ['recovery-approver']
  });

  const eventsRes = await app.inject({
    method: 'GET',
    url: '/v1/security/events?type=security_export_operator_policy_updated&limit=5',
    headers: authHeaders('tenant-admin-key', tenantId)
  });

  assert.equal(eventsRes.statusCode, 200);
  const events = eventsRes.json();
  assert.ok(events.data.some((event: any) => event.type === 'security_export_operator_policy_updated'));
});

test('roster_required mode rejects incomplete role assignment', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/v1/security/export/operator-policy',
    headers: authHeaders('tenant-admin-key', 'tenant-operator-policy-invalid'),
    payload: {
      mode: 'roster_required',
      roster: {
        acknowledge: ['incident-commander'],
        clear_request: ['recovery-requester'],
        clear_approve: []
      }
    }
  });

  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error.type, 'invalid_request_error');
  assert.match(body.error.message, /clear_approve/i);
});

test('DELETE /v1/security/export/operator-policy resets tenant override', async () => {
  const tenantId = 'tenant-operator-policy-reset';
  const updateRes = await app.inject({
    method: 'PUT',
    url: '/v1/security/export/operator-policy',
    headers: authHeaders('tenant-admin-key', tenantId),
    payload: {
      mode: 'roster_required',
      roster: {
        acknowledge: ['incident-commander'],
        clear_request: ['recovery-requester'],
        clear_approve: ['recovery-approver']
      }
    }
  });
  assert.equal(updateRes.statusCode, 200);

  const resetRes = await app.inject({
    method: 'DELETE',
    url: '/v1/security/export/operator-policy',
    headers: {
      authorization: 'Bearer tenant-admin-key',
      'x-tenant-id': tenantId
    }
  });

  assert.equal(resetRes.statusCode, 200);
  const body = resetRes.json();
  assert.equal(body.reset, true);
  assert.equal(body.source, 'deployment');
  assert.equal(body.mode, 'open_admins');

  const eventsRes = await app.inject({
    method: 'GET',
    url: '/v1/security/events?type=security_export_operator_policy_reset&limit=5',
    headers: authHeaders('tenant-admin-key', tenantId)
  });

  assert.equal(eventsRes.statusCode, 200);
  const events = eventsRes.json();
  assert.ok(events.data.some((event: any) => event.type === 'security_export_operator_policy_reset'));
});

test('read-only credential cannot update operator policy', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/v1/security/export/operator-policy',
    headers: authHeaders('tenant-read-key', 'tenant-operator-policy-readonly'),
    payload: {
      mode: 'open_admins',
      roster: {
        acknowledge: [],
        clear_request: [],
        clear_approve: []
      }
    }
  });

  assert.equal(res.statusCode, 403);
  const body = res.json();
  assert.equal(body.error.type, 'permission_error');
  assert.match(body.error.message, /tenant:admin/);
});
