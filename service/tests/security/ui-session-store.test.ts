import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uiSessionStore } from '../../security/ui-session-store.js';

test('ui session store issues and revokes token', () => {
  const issued = uiSessionStore.issue('tenant-x', 60);

  const resolved = uiSessionStore.resolve(issued.token);
  assert.ok(resolved);
  assert.equal(resolved?.tenantId, 'tenant-x');

  const revoked = uiSessionStore.revoke(issued.token);
  assert.equal(revoked, true);
  assert.equal(uiSessionStore.resolve(issued.token), null);
});
