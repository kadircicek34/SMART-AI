import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
const originalDateNow = Date.now;
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
};
let operatorDelegationModule: typeof import('../../security/export-operator-delegation.js');

before(async () => {
  process.env.APP_API_KEYS = '';
  process.env.APP_API_KEY_DEFINITIONS = JSON.stringify([
    { name: 'tenant-admin', key: 'test-admin-key', scopes: ['tenant:admin'] },
    { name: 'incident-commander', key: 'test-incident-commander-key', scopes: ['tenant:admin'] },
    { name: 'recovery-requester', key: 'test-recovery-requester-key', scopes: ['tenant:admin'] },
    { name: 'recovery-approver', key: 'test-recovery-approver-key', scopes: ['tenant:admin'] },
    { name: 'night-shift', key: 'test-night-shift-key', scopes: ['tenant:admin'] },
    { name: 'backup-approver', key: 'test-backup-approver-key', scopes: ['tenant:admin'] },
    { name: 'tenant-read', key: 'test-read-key', scopes: ['tenant:read'] }
  ]);
  process.env.KEY_STORE_FILE = `/tmp/smart-ai-test-keys-security-export-operator-delegations-${process.pid}.json`;
  process.env.MODEL_POLICY_FILE = `/tmp/smart-ai-test-model-policy-security-export-operator-delegations-${process.pid}.json`;
  process.env.SECURITY_AUDIT_STORE_FILE = `/tmp/smart-ai-test-security-audit-security-export-operator-delegations-${process.pid}.json`;
  process.env.RAG_REMOTE_POLICY_FILE = `/tmp/smart-ai-test-rag-remote-policy-security-export-operator-delegations-${process.pid}.json`;
  process.env.SECURITY_EXPORT_DELIVERY_STORE_FILE = `/tmp/smart-ai-test-security-export-operator-delegations-deliveries-${process.pid}.json`;
  process.env.SECURITY_EXPORT_DELIVERY_POLICY_FILE = `/tmp/smart-ai-test-security-export-operator-delegations-delivery-policy-${process.pid}.json`;
  process.env.SECURITY_EXPORT_OPERATOR_POLICY_FILE = `/tmp/smart-ai-test-security-export-operator-delegations-policy-${process.pid}.json`;
  process.env.SECURITY_EXPORT_OPERATOR_DELEGATION_FILE = `/tmp/smart-ai-test-security-export-operator-delegations-${process.pid}.json`;
  process.env.SECURITY_EXPORT_SIGNING_STORE_FILE = `/tmp/smart-ai-test-security-export-signing-operator-delegations-${process.pid}.json`;
  process.env.SECURITY_EXPORT_OPERATOR_POLICY_DEFAULT_MODE = 'open_admins';
  process.env.SECURITY_EXPORT_OPERATOR_DELEGATION_DEFAULT_TTL_MINUTES = '30';
  process.env.SECURITY_EXPORT_OPERATOR_DELEGATION_MAX_TTL_MINUTES = '120';
  process.env.SECURITY_EXPORT_OPERATOR_DELEGATION_MAX_ACTIVE_PER_TENANT = '4';
  process.env.SECURITY_EXPORT_DELIVERY_POLICY_DEFAULT_MODE = 'disabled';
  process.env.SECURITY_EXPORT_DELIVERY_QUARANTINE_FAILURE_THRESHOLD = '2';
  process.env.SECURITY_EXPORT_DELIVERY_QUARANTINE_DEAD_LETTER_THRESHOLD = '2';
  process.env.SECURITY_EXPORT_DELIVERY_QUARANTINE_DURATION_MINUTES = '60';
  process.env.SECURITY_EXPORT_DELIVERY_CLEAR_REQUEST_TTL_MINUTES = '20';
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 11).toString('base64');
  process.env.UI_ALLOWED_ORIGINS = 'https://dashboard.example.com';

  const deliveryModule = await import('../../security/export-delivery.js');
  deliveryPrivate = deliveryModule.__private__;
  deliveryPrivate.setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
  deliveryPrivate.setAutoProcessForTests(false);

  operatorDelegationModule = await import('../../security/export-operator-delegation.js');

  const mod = await import('../../api/app.js');
  app = mod.buildApp();
});

after(async () => {
  Date.now = originalDateNow;
  deliveryPrivate.setTransportForTests();
  deliveryPrivate.setLookupForTests();
  deliveryPrivate.setAutoProcessForTests(true);
  deliveryPrivate.resetStoreForTests();
  operatorDelegationModule.__private__.resetStoreForTests();
  await app.close();
});

beforeEach(() => {
  Date.now = originalDateNow;
  deliveryPrivate.resetStoreForTests();
  deliveryPrivate.setAutoProcessForTests(false);
  deliveryPrivate.setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
  operatorDelegationModule.__private__.resetStoreForTests();
});

async function createSession(tenantId: string, apiKey: string) {
  const sessionRes = await app.inject({
    method: 'POST',
    url: '/ui/session',
    payload: {
      apiKey,
      tenantId
    },
    headers: {
      origin: 'https://dashboard.example.com'
    }
  });

  assert.equal(sessionRes.statusCode, 200);
  return sessionRes.json();
}

async function createAdminSession(tenantId: string) {
  return createSession(tenantId, 'test-admin-key');
}

async function allowDeliveryTarget(tenantId: string, allowedTargets = ['siem.example.com/hooks']) {
  const policyRes = await app.inject({
    method: 'PUT',
    url: '/v1/security/export/delivery-policy',
    headers: {
      authorization: 'Bearer test-admin-key',
      'x-tenant-id': tenantId,
      'content-type': 'application/json'
    },
    payload: {
      mode: 'allowlist_only',
      allowedTargets
    }
  });

  assert.equal(policyRes.statusCode, 200);
}

async function allowOperatorRoster(
  tenantId: string,
  roster = {
    acknowledge: ['incident-commander'],
    clear_request: ['recovery-requester'],
    clear_approve: ['recovery-approver']
  }
) {
  const policyRes = await app.inject({
    method: 'PUT',
    url: '/v1/security/export/operator-policy',
    headers: {
      authorization: 'Bearer test-admin-key',
      'x-tenant-id': tenantId,
      'content-type': 'application/json'
    },
    payload: {
      mode: 'roster_required',
      roster
    }
  });

  assert.equal(policyRes.statusCode, 200);
}

async function createIncident(tenantId: string, destinationUrl: string) {
  const session = await createAdminSession(tenantId);
  await allowDeliveryTarget(tenantId);
  await allowOperatorRoster(tenantId);

  deliveryPrivate.setTransportForTests(async () => ({
    statusCode: 503,
    bodyText: 'upstream unavailable',
    bodyTruncated: false,
    durationMs: 15,
    contentType: 'text/plain'
  }));

  for (let attempt = 0; attempt < 2; attempt += 1) {
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
        destinationUrl,
        mode: 'sync',
        windowHours: 24,
        limit: 50
      }
    });

    assert.equal(res.statusCode, 502);
  }

  const incidentsRes = await app.inject({
    method: 'GET',
    url: '/v1/security/export/delivery-incidents?status=active&limit=5',
    headers: {
      authorization: 'Bearer test-admin-key',
      'x-tenant-id': tenantId
    }
  });

  assert.equal(incidentsRes.statusCode, 200);
  const incidents = incidentsRes.json();
  assert.equal(incidents.data.length, 1);
  return incidents.data[0];
}

test('operator delegations can be issued, listed, and revoked with audit telemetry', async () => {
  const tenantId = 'tenant-security-export-operator-delegation-crud';
  const incident = await createIncident(tenantId, 'https://siem.example.com/hooks/delegation-crud');

  const issueRes = await app.inject({
    method: 'POST',
    url: '/v1/security/export/operator-delegations',
    headers: {
      authorization: 'Bearer test-recovery-approver-key',
      'x-tenant-id': tenantId,
      'content-type': 'application/json',
      origin: 'https://dashboard.example.com'
    },
    payload: {
      incidentId: incident.incident_id,
      action: 'acknowledge',
      delegatePrincipal: 'night-shift',
      justification: 'Primary commander unavailable, temporary on-call handoff gerekiyor.',
      ttlMinutes: 25
    }
  });

  assert.equal(issueRes.statusCode, 200);
  const issued = issueRes.json().data;
  assert.equal(issued.status, 'active');
  assert.equal(issued.action, 'acknowledge');
  assert.equal(issued.delegate_principal, 'night-shift');
  assert.equal(issued.issued_by, 'recovery-approver');
  assert.equal(issued.incident_id, incident.incident_id);

  const listRes = await app.inject({
    method: 'GET',
    url: '/v1/security/export/operator-delegations?status=active&limit=5',
    headers: {
      authorization: 'Bearer test-admin-key',
      'x-tenant-id': tenantId
    }
  });

  assert.equal(listRes.statusCode, 200);
  const list = listRes.json();
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].grant_id, issued.grant_id);

  const revokeRes = await app.inject({
    method: 'POST',
    url: `/v1/security/export/operator-delegations/${issued.grant_id}/revoke`,
    headers: {
      authorization: 'Bearer test-recovery-approver-key',
      'x-tenant-id': tenantId,
      'content-type': 'application/json',
      origin: 'https://dashboard.example.com'
    },
    payload: {
      reason: 'Primary commander returned, break-glass delegation kapatılıyor.'
    }
  });

  assert.equal(revokeRes.statusCode, 200);
  const revoked = revokeRes.json().data;
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.revoked_by, 'recovery-approver');

  const eventsRes = await app.inject({
    method: 'GET',
    url: '/v1/security/events?limit=20',
    headers: {
      authorization: 'Bearer test-admin-key',
      'x-tenant-id': tenantId
    }
  });

  assert.equal(eventsRes.statusCode, 200);
  const events = eventsRes.json();
  assert.ok(events.data.some((event: any) => event.type === 'security_export_operator_delegation_issued'));
  assert.ok(events.data.some((event: any) => event.type === 'security_export_operator_delegation_revoked'));
});

test('delegated on-call operators can execute clear-request and clear approval for a single incident', async () => {
  const tenantId = 'tenant-security-export-operator-delegation-workflow';
  const incident = await createIncident(tenantId, 'https://siem.example.com/hooks/delegation-workflow');

  const ackRes = await app.inject({
    method: 'POST',
    url: `/v1/security/export/delivery-incidents/${incident.incident_id}/acknowledge`,
    headers: {
      authorization: 'Bearer test-incident-commander-key',
      'x-tenant-id': tenantId,
      'content-type': 'application/json',
      origin: 'https://dashboard.example.com'
    },
    payload: {
      note: 'Commander acknowledged the incident and needs delegated recovery coverage.',
      revision: incident.revision
    }
  });

  assert.equal(ackRes.statusCode, 200);
  const acknowledged = ackRes.json().data;

  Date.now = () => originalDateNow() + 61 * 60 * 1000;
  deliveryPrivate.setTransportForTests(async () => ({
    statusCode: 202,
    bodyText: 'accepted',
    bodyTruncated: false,
    durationMs: 10,
    contentType: 'text/plain'
  }));

  const issueClearRequestGrantRes = await app.inject({
    method: 'POST',
    url: '/v1/security/export/operator-delegations',
    headers: {
      authorization: 'Bearer test-recovery-approver-key',
      'x-tenant-id': tenantId,
      'content-type': 'application/json',
      origin: 'https://dashboard.example.com'
    },
    payload: {
      incidentId: incident.incident_id,
      action: 'clear_request',
      delegatePrincipal: 'night-shift',
      justification: 'Primary recovery requester unavailable, on-call operator live canaryyi çalıştıracak.',
      ttlMinutes: 30
    }
  });

  assert.equal(issueClearRequestGrantRes.statusCode, 200);
  const clearRequestGrant = issueClearRequestGrantRes.json().data;

  const clearRequestRes = await app.inject({
    method: 'POST',
    url: `/v1/security/export/delivery-incidents/${incident.incident_id}/clear-request`,
    headers: {
      authorization: 'Bearer test-night-shift-key',
      'x-tenant-id': tenantId,
      'content-type': 'application/json',
      origin: 'https://dashboard.example.com'
    },
    payload: {
      note: 'On-call operator canlı canaryyi doğruladı ve reopen onayı talep ediyor.',
      revision: acknowledged.revision
    }
  });

  assert.equal(clearRequestRes.statusCode, 200);
  const clearRequested = clearRequestRes.json().data;
  assert.equal(clearRequested.clear_request.requested_by, 'night-shift');

  const issueClearGrantRes = await app.inject({
    method: 'POST',
    url: '/v1/security/export/operator-delegations',
    headers: {
      authorization: 'Bearer test-recovery-approver-key',
      'x-tenant-id': tenantId,
      'content-type': 'application/json',
      origin: 'https://dashboard.example.com'
    },
    payload: {
      incidentId: incident.incident_id,
      action: 'clear_approve',
      delegatePrincipal: 'backup-approver',
      justification: 'Primary approver unavailable, backup operator four-eyes approval verecek.',
      ttlMinutes: 30
    }
  });

  assert.equal(issueClearGrantRes.statusCode, 200);
  const clearGrant = issueClearGrantRes.json().data;

  const clearRes = await app.inject({
    method: 'POST',
    url: `/v1/security/export/delivery-incidents/${incident.incident_id}/clear`,
    headers: {
      authorization: 'Bearer test-backup-approver-key',
      'x-tenant-id': tenantId,
      'content-type': 'application/json',
      origin: 'https://dashboard.example.com'
    },
    payload: {
      note: 'Backup operator second-operator approval verdi ve hedefi yeniden açtı.',
      revision: clearRequested.revision
    }
  });

  assert.equal(clearRes.statusCode, 200);
  const cleared = clearRes.json().data;
  assert.equal(cleared.cleared_by, 'backup-approver');
  assert.equal(cleared.status, 'resolved');

  const consumedRes = await app.inject({
    method: 'GET',
    url: '/v1/security/export/operator-delegations?status=consumed&limit=10',
    headers: {
      authorization: 'Bearer test-admin-key',
      'x-tenant-id': tenantId
    }
  });

  assert.equal(consumedRes.statusCode, 200);
  const consumed = consumedRes.json();
  const grantIds = consumed.data.map((entry: any) => entry.grant_id);
  assert.ok(grantIds.includes(clearRequestGrant.grant_id));
  assert.ok(grantIds.includes(clearGrant.grant_id));
  assert.ok(consumed.data.some((entry: any) => entry.consumed_by === 'night-shift'));
  assert.ok(consumed.data.some((entry: any) => entry.consumed_by === 'backup-approver'));

  const eventsRes = await app.inject({
    method: 'GET',
    url: '/v1/security/events?limit=30',
    headers: {
      authorization: 'Bearer test-admin-key',
      'x-tenant-id': tenantId
    }
  });

  assert.equal(eventsRes.statusCode, 200);
  const events = eventsRes.json();
  assert.ok(events.data.some((event: any) => event.type === 'security_export_operator_delegation_consumed'));
  assert.ok(events.data.some((event: any) => event.type === 'security_export_delivery_incident_cleared'));
});
