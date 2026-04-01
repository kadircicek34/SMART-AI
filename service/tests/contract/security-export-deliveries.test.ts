import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let deliveryStoreFile = '';
let securityAuditLog: any;
let deliveryPrivate: {
  resetStoreForTests: () => void;
  setAutoProcessForTests: (enabled?: boolean) => void;
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
  processRetryQueueForTests: (options?: { force?: boolean }) => Promise<number>;
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
  process.env.SECURITY_EXPORT_SIGNING_STORE_FILE = `/tmp/smart-ai-test-security-export-signing-deliveries-${process.pid}.json`;
  process.env.SECURITY_EXPORT_SIGNING_MAX_VERIFY_KEYS = '2';
  process.env.OPENROUTER_ALLOWED_MODELS = 'deepseek/deepseek-chat-v3.1,openai/gpt-4o-mini';
  process.env.OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-chat-v3.1';
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 4).toString('base64');
  process.env.UI_ALLOWED_ORIGINS = 'https://dashboard.example.com';
  process.env.SECURITY_EXPORT_DELIVERY_MAX_ACTIVE_PER_TENANT = '1';
  process.env.SECURITY_EXPORT_DELIVERY_MAX_ATTEMPTS = '3';
  process.env.SECURITY_EXPORT_DELIVERY_RETRY_BASE_DELAY_MS = '10';
  process.env.SECURITY_EXPORT_DELIVERY_RETRY_MAX_DELAY_MS = '25';
  process.env.SECURITY_EXPORT_DELIVERY_IDEMPOTENCY_TTL_SECONDS = '3600';
  process.env.SECURITY_EXPORT_DELIVERY_IDEMPOTENCY_KEY_MAX_LENGTH = '64';

  deliveryStoreFile = process.env.SECURITY_EXPORT_DELIVERY_STORE_FILE;

  const auditModule = await import('../../security/audit-log.js');
  securityAuditLog = auditModule.securityAuditLog;

  const deliveryModule = await import('../../security/export-delivery.js');
  deliveryPrivate = deliveryModule.__private__;
  deliveryPrivate.setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
  deliveryPrivate.setAutoProcessForTests(false);

  const mod = await import('../../api/app.js');
  app = mod.buildApp();
});

after(async () => {
  deliveryPrivate.setTransportForTests();
  deliveryPrivate.setLookupForTests();
  deliveryPrivate.setAutoProcessForTests(true);
  deliveryPrivate.resetStoreForTests();
  await app.close();
});

beforeEach(() => {
  deliveryPrivate.setTransportForTests();
  deliveryPrivate.resetStoreForTests();
  deliveryPrivate.setAutoProcessForTests(false);
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

async function allowDeliveryHost(tenantId: string) {
  const policyRes = await app.inject({
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

  assert.equal(policyRes.statusCode, 200);
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

test('POST /v1/security/export/deliveries signs and dispatches a tamper-evident bundle in sync mode', async () => {
  const tenantId = 'tenant-security-delivery-success';
  const session = await createAdminSession(tenantId);
  await allowDeliveryHost(tenantId);

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
      mode: 'sync',
      windowHours: 24,
      limit: 50,
      topIpLimit: 5
    }
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.object, 'security_export_delivery');
  assert.equal(body.data.mode, 'sync');
  assert.equal(body.data.status, 'succeeded');
  assert.equal(body.data.http_status, 202);
  assert.equal(body.data.attempt_count, 1);
  assert.equal(body.data.destination.host, 'siem.example.com');
  assert.equal(body.data.destination.origin, 'https://siem.example.com');
  assert.equal(body.data.destination.path_hint, '/…');
  assert.equal(body.data.destination.matched_host_rule, 'siem.example.com');
  assert.equal(body.data.pinned_address, '93.184.216.34');
  assert.equal(body.data.signature.algorithm, 'Ed25519');
  assert.match(body.data.signature.key_id, /^sexp_/);
  assert.match(body.data.signature.body_sha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(body.data).includes('hidden'));

  assert.ok(capturedPrepared);
  assert.equal(capturedPrepared.target.hostname, 'siem.example.com');
  assert.equal(capturedPrepared.target.matchedHostRule, 'siem.example.com');
  assert.equal(capturedPrepared.pinnedAddress.address, '93.184.216.34');
  assert.equal(capturedPrepared.headers['x-smart-ai-signature-alg'], 'Ed25519');
  assert.match(capturedPrepared.headers['x-smart-ai-signature-key-id'] ?? '', /^sexp_/);
  assert.match(capturedPrepared.headers['x-smart-ai-signature'] ?? '', /^ed25519=:/);
  assert.match(capturedPrepared.headers['content-digest'] ?? '', /^sha-256=:/);
  assert.equal(capturedPrepared.headers['x-smart-ai-head-chain-hash'], body.data.head_chain_hash);

  const deliveredPayload = JSON.parse(capturedPrepared.payload);
  assert.equal(deliveredPayload.object, 'security_audit_export');
  assert.equal(deliveredPayload.tenant_id, tenantId);
  assert.ok(Array.isArray(deliveredPayload.data));
  assert.ok(deliveredPayload.data.length >= 2);
  assert.equal(deliveredPayload.signature.algorithm, 'Ed25519');
  assert.match(deliveredPayload.signature.key_id, /^sexp_/);

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

test('async security export delivery encrypts queued payload, deduplicates by Idempotency-Key, enforces active cap and eventually succeeds', async () => {
  const tenantId = 'tenant-security-delivery-async';
  const session = await createAdminSession(tenantId);
  await allowDeliveryHost(tenantId);

  securityAuditLog.record({
    tenant_id: tenantId,
    type: 'api_auth_failed',
    details: {
      marker: 'super-sensitive-retry-payload'
    }
  });

  let attempts = 0;
  deliveryPrivate.setTransportForTests(async () => {
    attempts += 1;
    if (attempts === 1) {
      return {
        statusCode: 503,
        bodyText: 'retry later',
        bodyTruncated: false,
        durationMs: 11
      };
    }

    return {
      statusCode: 202,
      bodyText: JSON.stringify({ accepted: true }),
      bodyTruncated: false,
      durationMs: 13,
      contentType: 'application/json'
    };
  });

  const queuedRes = await app.inject({
    method: 'POST',
    url: '/v1/security/export/deliveries',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': tenantId,
      'content-type': 'application/json',
      origin: 'https://dashboard.example.com',
      'idempotency-key': 'async-delivery-1'
    },
    payload: {
      destinationUrl: 'https://siem.example.com/hooks/tenant-a?token=hidden',
      mode: 'async',
      windowHours: 24,
      limit: 50,
      topIpLimit: 5
    }
  });

  assert.equal(queuedRes.statusCode, 202);
  const queuedBody = queuedRes.json();
  assert.equal(queuedBody.object, 'security_export_delivery');
  assert.equal(queuedBody.queued, true);
  assert.equal(queuedBody.idempotencyReused, false);
  assert.equal(queuedBody.data.mode, 'async');
  assert.equal(queuedBody.data.status, 'queued');
  assert.equal(queuedBody.data.attempt_count, 0);
  assert.ok(queuedBody.data.next_attempt_at);

  const rawStore = await fs.readFile(deliveryStoreFile, 'utf8');
  assert.ok(!rawStore.includes('super-sensitive-retry-payload'));
  assert.ok(!rawStore.includes('marker'));

  const reusedRes = await app.inject({
    method: 'POST',
    url: '/v1/security/export/deliveries',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': tenantId,
      'content-type': 'application/json',
      origin: 'https://dashboard.example.com',
      'idempotency-key': 'async-delivery-1'
    },
    payload: {
      destinationUrl: 'https://siem.example.com/hooks/tenant-a?token=hidden',
      mode: 'async',
      windowHours: 24,
      limit: 50,
      topIpLimit: 5
    }
  });

  assert.equal(reusedRes.statusCode, 200);
  const reusedBody = reusedRes.json();
  assert.equal(reusedBody.idempotencyReused, true);
  assert.equal(reusedBody.data.delivery_id, queuedBody.data.delivery_id);

  const conflictRes = await app.inject({
    method: 'POST',
    url: '/v1/security/export/deliveries',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': tenantId,
      'content-type': 'application/json',
      origin: 'https://dashboard.example.com',
      'idempotency-key': 'async-delivery-1'
    },
    payload: {
      destinationUrl: 'https://siem.example.com/hooks/tenant-conflict?token=hidden',
      mode: 'async',
      windowHours: 24,
      limit: 50,
      topIpLimit: 5
    }
  });

  assert.equal(conflictRes.statusCode, 409);

  const capRes = await app.inject({
    method: 'POST',
    url: '/v1/security/export/deliveries',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': tenantId,
      'content-type': 'application/json',
      origin: 'https://dashboard.example.com',
      'idempotency-key': 'async-delivery-2'
    },
    payload: {
      destinationUrl: 'https://siem.example.com/hooks/tenant-b?token=hidden',
      mode: 'async',
      windowHours: 24,
      limit: 50,
      topIpLimit: 5
    }
  });

  assert.equal(capRes.statusCode, 429);

  assert.equal(await deliveryPrivate.processRetryQueueForTests({ force: true }), 1);
  assert.equal(await deliveryPrivate.processRetryQueueForTests({ force: true }), 1);

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
  assert.equal(deliveries.data.length, 1);
  assert.equal(deliveries.data[0].status, 'succeeded');
  assert.equal(deliveries.data[0].attempt_count, 2);
  assert.equal(deliveries.data[0].mode, 'async');

  const failedEventsRes = await app.inject({
    method: 'GET',
    url: '/v1/security/events?type=security_export_delivery_failed&limit=10',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': tenantId
    }
  });

  assert.equal(failedEventsRes.statusCode, 200);
  const failedEvents = failedEventsRes.json();
  assert.ok(failedEvents.data.some((event: any) => event.type === 'security_export_delivery_failed'));

  const deliveredEventsRes = await app.inject({
    method: 'GET',
    url: '/v1/security/events?type=security_export_delivered&limit=10',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': tenantId
    }
  });

  assert.equal(deliveredEventsRes.statusCode, 200);
  const deliveredEvents = deliveredEventsRes.json();
  assert.ok(deliveredEvents.data.some((event: any) => event.type === 'security_export_delivered'));
});

test('async security export delivery dead-letters after max retry attempts and is filterable by status', async () => {
  const tenantId = 'tenant-security-delivery-dead-letter';
  const session = await createAdminSession(tenantId);
  await allowDeliveryHost(tenantId);

  deliveryPrivate.setTransportForTests(async () => ({
    statusCode: 503,
    bodyText: 'upstream unavailable',
    bodyTruncated: false,
    durationMs: 17
  }));

  const queuedRes = await app.inject({
    method: 'POST',
    url: '/v1/security/export/deliveries',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': tenantId,
      'content-type': 'application/json',
      origin: 'https://dashboard.example.com',
      'idempotency-key': 'async-dead-letter-1'
    },
    payload: {
      destinationUrl: 'https://siem.example.com/hooks/tenant-dead-letter',
      mode: 'async',
      windowHours: 24,
      limit: 50,
      topIpLimit: 5
    }
  });

  assert.equal(queuedRes.statusCode, 202);
  await deliveryPrivate.processRetryQueueForTests({ force: true });
  await deliveryPrivate.processRetryQueueForTests({ force: true });
  await deliveryPrivate.processRetryQueueForTests({ force: true });

  const deliveriesRes = await app.inject({
    method: 'GET',
    url: '/v1/security/export/deliveries?limit=10&status=dead_letter',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': tenantId
    }
  });

  assert.equal(deliveriesRes.statusCode, 200);
  const deliveries = deliveriesRes.json();
  assert.equal(deliveries.object, 'list');
  assert.equal(deliveries.data.length, 1);
  assert.equal(deliveries.data[0].status, 'dead_letter');
  assert.equal(deliveries.data[0].attempt_count, 3);
  assert.ok(deliveries.data[0].dead_lettered_at);
  assert.ok(deliveries.data[0].completed_at);

  const eventsRes = await app.inject({
    method: 'GET',
    url: '/v1/security/events?type=security_export_delivery_dead_lettered&limit=5',
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-tenant-id': tenantId
    }
  });

  assert.equal(eventsRes.statusCode, 200);
  const events = eventsRes.json();
  assert.ok(events.data.some((event: any) => event.type === 'security_export_delivery_dead_lettered'));
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
      mode: 'async',
      windowHours: 24,
      limit: 20
    }
  });
  assert.equal(createRes.statusCode, 403);
});
