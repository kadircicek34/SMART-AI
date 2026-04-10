import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let delegationModule: typeof import('../../security/export-operator-delegation.js');
const originalDateNow = Date.now;

before(async () => {
  process.env.SECURITY_EXPORT_OPERATOR_DELEGATION_FILE = `/tmp/smart-ai-test-security-export-operator-delegation-unit-${process.pid}.json`;
  process.env.SECURITY_EXPORT_OPERATOR_DELEGATION_DEFAULT_TTL_MINUTES = '30';
  process.env.SECURITY_EXPORT_OPERATOR_DELEGATION_MAX_TTL_MINUTES = '90';
  process.env.SECURITY_EXPORT_OPERATOR_DELEGATION_MAX_ACTIVE_PER_TENANT = '2';

  delegationModule = await import('../../security/export-operator-delegation.js');
});

after(() => {
  Date.now = originalDateNow;
  delegationModule.__private__.resetStoreForTests();
});

beforeEach(() => {
  Date.now = originalDateNow;
  delegationModule.__private__.resetStoreForTests();
});

test('delegation grants can be created, discovered, and consumed once', async () => {
  const created = await delegationModule.createSecurityExportOperatorDelegation({
    tenantId: 'tenant-unit-delegation-lifecycle',
    incidentId: '4ff5304f-3c9e-4d8b-b79a-7fd86f14ba91',
    action: 'clear_request',
    delegatePrincipal: 'night-shift',
    actor: 'recovery-approver',
    justification: 'Temporary on-call handoff for live canary execution.',
    ttlMinutes: 20
  });

  assert.equal(created.ok, true);
  if (!created.ok) {
    throw new Error('expected delegation grant to be created');
  }

  const active = await delegationModule.findActiveSecurityExportOperatorDelegation({
    tenantId: 'tenant-unit-delegation-lifecycle',
    incidentId: '4ff5304f-3c9e-4d8b-b79a-7fd86f14ba91',
    action: 'clear_request',
    delegatePrincipal: 'night-shift'
  });

  assert.ok(active);
  assert.equal(active?.grant_id, created.grant.grant_id);

  const consumed = await delegationModule.consumeSecurityExportOperatorDelegation({
    tenantId: 'tenant-unit-delegation-lifecycle',
    grantId: created.grant.grant_id,
    incidentId: '4ff5304f-3c9e-4d8b-b79a-7fd86f14ba91',
    action: 'clear_request',
    actor: 'night-shift'
  });

  assert.equal(consumed.ok, true);
  if (!consumed.ok) {
    throw new Error('expected delegation grant consumption to succeed');
  }
  assert.equal(consumed.grant.status, 'consumed');
  assert.equal(consumed.grant.consumed_by, 'night-shift');

  const afterConsume = await delegationModule.findActiveSecurityExportOperatorDelegation({
    tenantId: 'tenant-unit-delegation-lifecycle',
    incidentId: '4ff5304f-3c9e-4d8b-b79a-7fd86f14ba91',
    action: 'clear_request',
    delegatePrincipal: 'night-shift'
  });

  assert.equal(afterConsume, null);
});

test('self-delegation and expired grants are rejected fail-closed', async () => {
  const selfDelegation = await delegationModule.createSecurityExportOperatorDelegation({
    tenantId: 'tenant-unit-delegation-self',
    incidentId: 'c9665900-f42c-4dfa-9f9b-ab7c774db66a',
    action: 'acknowledge',
    delegatePrincipal: 'recovery-approver',
    actor: 'recovery-approver',
    justification: 'Self delegation should never be allowed.',
    ttlMinutes: 10
  });

  assert.equal(selfDelegation.ok, false);
  if (selfDelegation.ok) {
    throw new Error('expected self-delegation to fail');
  }
  assert.equal(selfDelegation.code, 'delegate_principal_conflict');

  const created = await delegationModule.createSecurityExportOperatorDelegation({
    tenantId: 'tenant-unit-delegation-expiry',
    incidentId: 'df0f35d6-5126-42b0-8ef3-3681fd76e145',
    action: 'clear_approve',
    delegatePrincipal: 'backup-approver',
    actor: 'recovery-approver',
    justification: 'Temporary approval delegation for a short maintenance window.',
    ttlMinutes: 5
  });

  assert.equal(created.ok, true);
  if (!created.ok) {
    throw new Error('expected short-lived grant to be created');
  }

  Date.now = () => originalDateNow() + 6 * 60 * 1000;

  const expired = await delegationModule.findActiveSecurityExportOperatorDelegation({
    tenantId: 'tenant-unit-delegation-expiry',
    incidentId: 'df0f35d6-5126-42b0-8ef3-3681fd76e145',
    action: 'clear_approve',
    delegatePrincipal: 'backup-approver'
  });

  assert.equal(expired, null);

  const activeOnly = await delegationModule.listSecurityExportOperatorDelegations('tenant-unit-delegation-expiry', {
    status: 'active',
    limit: 5
  });
  assert.equal(activeOnly.length, 0);

  const expiredOnly = await delegationModule.listSecurityExportOperatorDelegations('tenant-unit-delegation-expiry', {
    status: 'expired',
    limit: 5
  });
  assert.equal(expiredOnly.length, 1);
  assert.equal(expiredOnly[0]?.status, 'expired');
});
