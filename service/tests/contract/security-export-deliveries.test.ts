import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let deliveryPrivate: {
  resetStoreForTests: () => void;
  setLookupForTests: (
    lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>
  ) => void;
  setTransportForTests: (
    transport?: (prepared: {
      deliveryId: string;
      target: {
        url: URL;
        hostname: string;
        matchedHostRule: string;
      };
      payload: string;
      headers: Record<string, string>;
      pinnedAddress: { address: string; family: number };
    }) => Promise<{
      statusCode: number;
      bodyText?: string;
      bodyTruncated?: boolean;
      durationMs?: number;
      contentType?: string;
    }>
  ) => void;
};

before(async () => {
  process.env.APP_API_KEYS = '';
  process.env.APP_API_KEY_DEFINITIONS = JSON.stringify([
    { name: 'tenant-admin', key: 'test-admin-key', scopes: ['tenant:admin'] },
    { name: 'tenant-read', key: 'test-read-key', scopes: ['tenant:read'] }
  ]);
  process.env.KEY_STORE_FILE = `/tmp/smart-ai-test-keys-security-export-deliveries-${process.pid}.json`;
  process.env.MODEL_POLICY_FILE = `/tmp/smart-ai-test-model-policy-security-export-deliveries-${process.pid}.json`;
  process.env.SECURITY_AUDIT_STORE_FILE = `/tmp/smart-ai-test-security-audit-security-export-deliveries-${process.pid}.json`;
  process.env.RAG_REMOTE_POLICY_FILE = `/tmp/smart-ai-test-rag-remote-policy-security-export-deliveries-${process.pid}.json`;
  process.env.SECURITY_EXPORT_DELIVERY_STORE_FILE = `/tmp/smart-ai-test-security-export-deliveries-${process.pid}.json`;
  process.env.OPENROUTER_ALLOWED_MODELS = 'deepseek/deepseek-chat-v3.1,openai/gpt-4o-mini';
  process.env.OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-chat-v3.1';
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 4).toString('base64');
  process.env.UI_ALLOWED_ORIGINS = 'https://dashboard.example.com';

  const deliveryModule = await import('../../security/export-delivery.js');
  deliveryPrivate = deliveryModule.__private__;
  deliveryPrivate.setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);

  const mod = await import('../../api/app.js');
  app = mod.buildApp();
});

after(async () => {
  deliveryPrivate.setTransportForTests();
  deliveryPrivate.setLookupForTests();
  deliveryPrivate.resetStoreForTests();
  await app.close();
});

beforeEach(() => {
  deliveryPrivate.setTransportForTests();
  deliveryPrivate.resetStoreForTests();
  deliveryPrivate.setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
});

async function createAdminSession(tenantId: string) {
  const sessionRes = await app.inject({
    method: 'POST',
    url: '/ui/session',
    payload: {
      apiKey: 'test-admin-key',
      tenantId
    },
    headers: {
      origin: 'https://dashboard.example.com'
    }
  });

  assert.equal(sessionRes.statusCode, 200);
  return sessionRes.json();
}

test('POST /v1/security/export/deliveries blocks hosts that are not on the tenant allowlist', async () => {
  const session = await createAdminSession('tenant-security-delivery-blocked');

  const res = await app.inject({
    method: 'POST',
    url: '/v1/security/export/deliveries',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': 'tenant-security-delivery-blocked',
      'content-type': 'application/json',
      origin: 'https://dashboard.example.com'
    },
    payload: {
      destinationUrl: 'https://siem.example.com/hooks/tenant-a?token=super-secret',
      windowHours: 24,
      limit: 50
    }
  });

  assert.equal(res.statusCode, 403);
  const body = res.json();
  assert.equal(body.error.type, 'permission_error');
  assert.match(body.error.message, /allowlist/i);
  assert.equal(body.delivery?.status, 'blocked');
  assert.equal(body.delivery?.destination?.host, 'siem.example.com');
  assert.equal(body.delivery?.destination?.path_hint, '/…');
  assert.ok(!JSON.stringify(body.delivery).includes('super-secret'));

  const deliveriesRes = await app.inject({
    method: 'GET',
    url: '/v1/security/export/deliveries?limit=5',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': 'tenant-security-delivery-blocked'
    }
  });

  assert.equal(deliveriesRes.statusCode, 200);
  const deliveries = deliveriesRes.json();
  assert.equal(deliveries.object, 'list');
  assert.equal(deliveries.data.length, 1);
  assert.equal(deliveries.data[0].status, 'blocked');

  const eventsRes = await app.inject({
    method: 'GET',
    url: '/v1/security/events?type=security_export_delivery_blocked&limit=5',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': 'tenant-security-delivery-blocked'
    }
  });

  assert.equal(eventsRes.statusCode, 200);
  const events = eventsRes.json();
  assert.ok(events.data.some((event: any) => event.type === 'security_export_delivery_blocked'));
});

test('POST /v1/security/export/deliveries signs and dispatches a tamper-evident bundle', async () => {
  const tenantId = 'tenant-security-delivery-success';
  const session = await createAdminSession(tenantId);

  await app.inject({
    method: 'PUT',
    url: '/v1/rag/remote-policy',
    headers: {
      authorization: 'Bearer test-admin-key',
      'x-tenant-id': tenantId,
      'content-type': 'application/json'
    },
    payload: {
      mode: 'allowlist_only',
      allowedHosts: ['siem.example.com']
    }
  });

  await app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: {
      authorization: 'Bearer invalid-token',
      'x-tenant-id': tenantId
    }
  });

  let capturedPrepared: any = null;
  deliveryPrivate.setTransportForTests(async (prepared) => {
    capturedPrepared = prepared;
    return {
      statusCode: 202,
      bodyText: JSON.stringify({ accepted: true }),
      bodyTruncated: false,
      durationMs: 24,
      contentType: 'application/json'
    };
  });

  const res = await app.inject({
    method: 'POST',
    url: '/v1/security/export/deliveries',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': tenantId,
      'content-type': 'application/json',
      origin: 'https://dashboard.example.com'
    },
    payload: {
      destinationUrl: 'https://siem.example.com/hooks/tenant-a?token=hidden',
      windowHours: 24,
      limit: 50,
      topIpLimit: 5
    }
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.object, 'security_export_delivery');
  assert.equal(body.data.status, 'succeeded');
  assert.equal(body.data.http_status, 202);
  assert.equal(body.data.destination.host, 'siem.example.com');
  assert.equal(body.data.destination.origin, 'https://siem.example.com');
  assert.equal(body.data.destination.path_hint, '/…');
  assert.equal(body.data.destination.matched_host_rule, 'siem.example.com');
  assert.equal(body.data.pinned_address, '93.184.216.34');
  assert.equal(body.data.signature.key_id, 'delivery-v1');
  assert.match(body.data.signature.body_sha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(body.data).includes('hidden'));

  assert.ok(capturedPrepared);
  assert.equal(capturedPrepared.target.hostname, 'siem.example.com');
  assert.equal(capturedPrepared.target.matchedHostRule, 'siem.example.com');
  assert.equal(capturedPrepared.pinnedAddress.address, '93.184.216.34');
  assert.match(capturedPrepared.headers['x-smart-ai-signature'] ?? '', /^v1=/);
  assert.match(capturedPrepared.headers['content-digest'] ?? '', /^sha-256=:/);
  assert.equal(capturedPrepared.headers['x-smart-ai-head-chain-hash'], body.data.head_chain_hash);

  const deliveredPayload = JSON.parse(capturedPrepared.payload);
  assert.equal(deliveredPayload.object, 'security_audit_export');
  assert.equal(deliveredPayload.tenant_id, tenantId);
  assert.ok(Array.isArray(deliveredPayload.data));
  assert.ok(deliveredPayload.data.length >= 2);

  const deliveriesRes = await app.inject({
    method: 'GET',
    url: '/v1/security/export/deliveries?limit=10',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': tenantId
    }
  });

  assert.equal(deliveriesRes.statusCode, 200);
  const deliveries = deliveriesRes.json();
  assert.equal(deliveries.object, 'list');
  assert.equal(deliveries.data.length, 1);
  assert.equal(deliveries.data[0].status, 'succeeded');

  const eventsRes = await app.inject({
    method: 'GET',
    url: '/v1/security/events?type=security_export_delivered&limit=5',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': tenantId
    }
  });

  assert.equal(eventsRes.statusCode, 200);
  const events = eventsRes.json();
  assert.ok(events.data.some((event: any) => event.type === 'security_export_delivered'));
});

test('read-only credential cannot list or create security export deliveries', async () => {
  const listRes = await app.inject({
    method: 'GET',
    url: '/v1/security/export/deliveries?limit=5',
    headers: {
      authorization: 'Bearer test-read-key',
      'x-tenant-id': 'tenant-security-delivery-read'
    }
  });
  assert.equal(listRes.statusCode, 403);

  const createRes = await app.inject({
    method: 'POST',
    url: '/v1/security/export/deliveries',
    headers: {
      authorization: 'Bearer test-read-key',
      'x-tenant-id': 'tenant-security-delivery-read',
      'content-type': 'application/json'
    },
    payload: {
      destinationUrl: 'https://siem.example.com/hooks/read-only',
      windowHours: 24,
      limit: 20
    }
  });
  assert.equal(createRes.statusCode, 403);
});
