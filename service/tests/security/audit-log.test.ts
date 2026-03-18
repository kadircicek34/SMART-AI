import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSecurityAuditLog } from '../../security/audit-log.js';

test('security audit log keeps last N events per tenant and supports reverse listing', () => {
  const log = createSecurityAuditLog(3);

  log.record({ tenant_id: 'tenant-a', type: 'ui_auth_failed' });
  log.record({ tenant_id: 'tenant-a', type: 'ui_auth_failed' });
  log.record({ tenant_id: 'tenant-a', type: 'ui_session_issued' });
  log.record({ tenant_id: 'tenant-a', type: 'api_auth_failed' });

  const events = log.list('tenant-a', { limit: 10 });
  assert.equal(events.length, 3);
  assert.equal(events[0].type, 'api_auth_failed');
  assert.equal(events[1].type, 'ui_session_issued');
  assert.equal(events[2].type, 'ui_auth_failed');
});

test('security audit log can filter by type and since timestamp', async () => {
  const log = createSecurityAuditLog(10);

  log.record({ tenant_id: 'tenant-b', type: 'ui_auth_failed' });
  const since = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 2));
  log.record({ tenant_id: 'tenant-b', type: 'ui_session_issued' });

  const byType = log.list('tenant-b', { type: 'ui_session_issued' });
  assert.equal(byType.length, 1);
  assert.equal(byType[0].type, 'ui_session_issued');

  const bySince = log.list('tenant-b', { sinceTimestamp: since });
  assert.equal(bySince.length, 1);
  assert.equal(bySince[0].type, 'ui_session_issued');
});
