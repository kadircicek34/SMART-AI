import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let delegationModule: typeof import('../../security/export-operator-delegation.js');
const originalDateNow = Date.now;

before(async () => {
  process.env.SECURITY_EXPORT_OPERATOR_DELEGATION_FILE = `/tmp/smart-ai-test-security-export-operator-delegation-unit-${process.pid}.json`;
  process.env.SECURITY_EXPORT_OPERATOR_DELEGATION_DEFAULT_TTL_MINUTES = '30';
  process.env.SECURITY_EXPORT_OPERATOR_DELEGATION_MAX_TTL_MINUTES = '90';
  process.env.SECURITY_EXPORT_OPERATOR_DELEGATION_MAX_ACTIVE_PER_TENANT = '2';
  process.env.SECURITY_EXPORT_OPERATOR_DELEGATION_MAX_PENDING_PER_TENANT = '3';
  process.env.SECURITY_EXPORT_OPERATOR_DELEGATION_APPROVAL_TTL_MINUTES = '10';

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

test('delegation requests can be created, approved, discovered, and consumed once', async () => {
  const created = await delegationModule.createSecurityExportOperatorDelegation({
    tenantId: 'tenant-unit-delegation-lifecycle',
    incidentId: '4ff5304f-3c9e-4d8b-b79a-7fd86f14ba91',
    action: 'clear_request',
    delegatePrincipal: 'night-shift',
    actor: 'delegation-requester',
    justification: 'Temporary on-call handoff for live canary execution.',
    ttlMinutes: 20
  });

  assert.equal(created.ok, true);
  if (!created.ok) {
    throw new Error('expected delegation request to be created');
  }
  assert.equal(created.grant.status, 'pending_approval');
  assert.equal(created.grant.requested_by, 'delegation-requester');
  assert.equal(created.grant.approved_by, null);

  const beforeApprove = await delegationModule.findActiveSecurityExportOperatorDelegation({
    tenantId: 'tenant-unit-delegation-lifecycle',
    incidentId: '4ff5304f-3c9e-4d8b-b79a-7fd86f14ba91',
    action: 'clear_request',
    delegatePrincipal: 'night-shift'
  });

  assert.equal(beforeApprove, null);

  const approved = await delegationModule.approveSecurityExportOperatorDelegation({
    tenantId: 'tenant-unit-delegation-lifecycle',
    grantId: created.grant.grant_id,
    actor: 'recovery-approver',
    note: 'Second operator approved the temporary break-glass handoff.'
  });

  assert.equal(approved.ok, true);
  if (!approved.ok) {
    throw new Error('expected delegation approval to succeed');
  }
  assert.equal(approved.grant.status, 'active');
  assert.equal(approved.grant.issued_by, 'recovery-approver');
  assert.equal(approved.grant.approved_by, 'recovery-approver');

  const active = await delegationModule.findActiveSecurityExportOperatorDelegation({
    tenantId: 'tenant-unit-delegation-lifecycle',
    incidentId: '4ff5304f-3c9e-4d8b-b79a-7fd86f14ba91',
    action: 'clear_request',
    delegatePrincipal: 'night-shift'
  });

  assert.ok(active);
  assert.equal(active?.grant_id, approved.grant.grant_id);

  const consumed = await delegationModule.consumeSecurityExportOperatorDelegation({
    tenantId: 'tenant-unit-delegation-lifecycle',
    grantId: approved.grant.grant_id,
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

test('self-approval, delegate approval, pending approval expiry, and active expiry are rejected fail-closed', async () => {
  const selfApprovalRequest = await delegationModule.createSecurityExportOperatorDelegation({
    tenantId: 'tenant-unit-delegation-self-approve',
    incidentId: 'c9665900-f42c-4dfa-9f9b-ab7c774db66a',
    action: 'acknowledge',
    delegatePrincipal: 'night-shift',
    actor: 'recovery-approver',
    justification: 'Need a second operator approval before activating break-glass access.',
    ttlMinutes: 10
  });

  assert.equal(selfApprovalRequest.ok, true);
  if (!selfApprovalRequest.ok) {
    throw new Error('expected pending request to be created');
  }

  const selfApproval = await delegationModule.approveSecurityExportOperatorDelegation({
    tenantId: 'tenant-unit-delegation-self-approve',
    grantId: selfApprovalRequest.grant.grant_id,
    actor: 'recovery-approver',
    note: 'Requester should never be able to approve the same request.'
  });

  assert.equal(selfApproval.ok, false);
  if (selfApproval.ok) {
    throw new Error('expected self-approval to fail');
  }
  assert.equal(selfApproval.code, 'approver_conflict');

  const delegateApproval = await delegationModule.approveSecurityExportOperatorDelegation({
    tenantId: 'tenant-unit-delegation-self-approve',
    grantId: selfApprovalRequest.grant.grant_id,
    actor: 'night-shift',
    note: 'Delegate principal must not activate their own break-glass grant.'
  });

  assert.equal(delegateApproval.ok, false);
  if (delegateApproval.ok) {
    throw new Error('expected delegate approval to fail');
  }
  assert.equal(delegateApproval.code, 'delegate_principal_conflict');

  const approvalExpiryRequest = await delegationModule.createSecurityExportOperatorDelegation({
    tenantId: 'tenant-unit-delegation-approval-expiry',
    incidentId: 'df0f35d6-5126-42b0-8ef3-3681fd76e145',
    action: 'clear_approve',
    delegatePrincipal: 'backup-approver',
    actor: 'primary-approver',
    justification: 'Temporary approval delegation needs second operator confirmation.',
    ttlMinutes: 5
  });

  assert.equal(approvalExpiryRequest.ok, true);
  if (!approvalExpiryRequest.ok) {
    throw new Error('expected pending request for approval expiry test');
  }

  Date.now = () => originalDateNow() + 11 * 60 * 1000;

  const expiredApproval = await delegationModule.approveSecurityExportOperatorDelegation({
    tenantId: 'tenant-unit-delegation-approval-expiry',
    grantId: approvalExpiryRequest.grant.grant_id,
    actor: 'second-approver',
    note: 'Approval arrives too late and must fail closed.'
  });

  assert.equal(expiredApproval.ok, false);
  if (expiredApproval.ok) {
    throw new Error('expected expired pending approval to fail');
  }
  assert.equal(expiredApproval.code, 'delegation_not_pending');

  const approvalExpiredOnly = await delegationModule.listSecurityExportOperatorDelegations('tenant-unit-delegation-approval-expiry', {
    status: 'approval_expired',
    limit: 5
  });
  assert.equal(approvalExpiredOnly.length, 1);
  assert.equal(approvalExpiredOnly[0]?.status, 'approval_expired');

  Date.now = originalDateNow;

  const activeExpiryRequest = await delegationModule.createSecurityExportOperatorDelegation({
    tenantId: 'tenant-unit-delegation-active-expiry',
    incidentId: '1c5a6f89-b4d1-477c-9b38-b8500ec2bf9a',
    action: 'clear_approve',
    delegatePrincipal: 'backup-approver',
    actor: 'primary-approver',
    justification: 'Temporary approval delegation for a short maintenance window.',
    ttlMinutes: 5
  });

  assert.equal(activeExpiryRequest.ok, true);
  if (!activeExpiryRequest.ok) {
    throw new Error('expected pending request for active expiry test');
  }

  const approved = await delegationModule.approveSecurityExportOperatorDelegation({
    tenantId: 'tenant-unit-delegation-active-expiry',
    grantId: activeExpiryRequest.grant.grant_id,
    actor: 'second-approver',
    note: 'Second operator approved the short-lived break-glass grant.'
  });

  assert.equal(approved.ok, true);
  if (!approved.ok) {
    throw new Error('expected approval to succeed before active expiry');
  }

  Date.now = () => originalDateNow() + 6 * 60 * 1000;

  const expiredActive = await delegationModule.findActiveSecurityExportOperatorDelegation({
    tenantId: 'tenant-unit-delegation-active-expiry',
    incidentId: '1c5a6f89-b4d1-477c-9b38-b8500ec2bf9a',
    action: 'clear_approve',
    delegatePrincipal: 'backup-approver'
  });

  assert.equal(expiredActive, null);

  const expiredOnly = await delegationModule.listSecurityExportOperatorDelegations('tenant-unit-delegation-active-expiry', {
    status: 'expired',
    limit: 5
  });
  assert.equal(expiredOnly.length, 1);
  assert.equal(expiredOnly[0]?.status, 'expired');
});
