import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

let operatorPolicyModule: typeof import('../../security/export-operator-policy.js');

before(async () => {
  process.env.SECURITY_EXPORT_OPERATOR_POLICY_FILE = `/tmp/smart-ai-test-security-export-operator-policy-unit-${process.pid}.json`;
  process.env.SECURITY_EXPORT_OPERATOR_POLICY_DEFAULT_MODE = 'open_admins';
  process.env.SECURITY_EXPORT_OPERATOR_POLICY_MAX_PRINCIPALS_PER_ROLE = '4';

  operatorPolicyModule = await import('../../security/export-operator-policy.js');
});

after(async () => {
  await operatorPolicyModule.resetTenantSecurityExportOperatorPolicy('tenant-unit-open-admins');
  await operatorPolicyModule.resetTenantSecurityExportOperatorPolicy('tenant-unit-roster');
});

test('open_admins mode authorizes any admin principal name', async () => {
  const decision = await operatorPolicyModule.evaluateSecurityExportOperatorAuthorization({
    tenantId: 'tenant-unit-open-admins',
    action: 'acknowledge',
    principalName: 'tenant-admin'
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'open_admins');
  assert.equal(decision.policy.mode, 'open_admins');
});

test('roster_required mode authorizes only principals listed for the matching action', async () => {
  const result = await operatorPolicyModule.setTenantSecurityExportOperatorPolicy('tenant-unit-roster', {
    mode: 'roster_required',
    roster: {
      acknowledge: ['incident-commander'],
      clear_request: ['recovery-requester'],
      clear_approve: ['recovery-approver']
    }
  });

  assert.equal(result.ok, true);

  const deny = await operatorPolicyModule.evaluateSecurityExportOperatorAuthorization({
    tenantId: 'tenant-unit-roster',
    action: 'clear_request',
    principalName: 'incident-commander'
  });
  assert.equal(deny.allowed, false);
  assert.equal(deny.reason, 'principal_not_in_role');

  const allow = await operatorPolicyModule.evaluateSecurityExportOperatorAuthorization({
    tenantId: 'tenant-unit-roster',
    action: 'clear_request',
    principalName: 'recovery-requester'
  });
  assert.equal(allow.allowed, true);
  assert.equal(allow.reason, 'role_match');
});

test('roster_required mode rejects empty role configuration', async () => {
  const result = operatorPolicyModule.validateTenantSecurityExportOperatorPolicyInput({
    mode: 'roster_required',
    roster: {
      acknowledge: ['incident-commander'],
      clear_request: ['recovery-requester'],
      clear_approve: []
    }
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error('expected validation error');
  }
  assert.equal(result.code, 'principal_required');
});
