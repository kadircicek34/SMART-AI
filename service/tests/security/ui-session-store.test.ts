import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uiSessionStore } from '../../security/ui-session-store.js';

test('ui session store issues and revokes token', () => {
  const issued = uiSessionStore.issue('tenant-x', 60);

  const resolved = uiSessionStore.resolve(issued.token);
  assert.ok(resolved.session);
  assert.equal(resolved.session?.tenantId, 'tenant-x');

  const revoked = uiSessionStore.revoke(issued.token);
  assert.equal(revoked, true);
  assert.equal(uiSessionStore.resolve(issued.token).session, null);
});

test('ui session store rotates token and preserves principal scopes', () => {
  const issued = uiSessionStore.issue('tenant-rotate', 60, {
    userAgent: 'agent-a',
    principalName: 'ops-user',
    scopes: ['tenant:read', 'tenant:operate']
  });

  const rotated = uiSessionStore.rotate(issued.token, 60, {
    userAgent: 'agent-a',
    maxIdleSeconds: 120,
    maxSessionsPerTenant: 5,
    maxSessionsGlobal: 500
  });

  assert.ok(rotated.session);
  assert.notEqual(rotated.session?.token, issued.token);
  assert.equal(uiSessionStore.resolve(issued.token).session, null);

  const hit = uiSessionStore.resolve(rotated.session!.token, { userAgent: 'agent-a', maxIdleSeconds: 120 });
  assert.ok(hit.session);
  assert.equal(hit.session?.principalName, 'ops-user');
  assert.deepEqual(hit.session?.scopes, ['tenant:read', 'tenant:operate']);

  uiSessionStore.revoke(rotated.session!.token);
});

test('ui session store enforces max sessions per tenant (oldest evicted)', () => {
  const first = uiSessionStore.issue('tenant-cap', 120, {
    userAgent: 'cap-agent',
    maxSessionsPerTenant: 2,
    maxSessionsGlobal: 1000
  });
  const second = uiSessionStore.issue('tenant-cap', 120, {
    userAgent: 'cap-agent',
    maxSessionsPerTenant: 2,
    maxSessionsGlobal: 1000
  });
  const third = uiSessionStore.issue('tenant-cap', 120, {
    userAgent: 'cap-agent',
    maxSessionsPerTenant: 2,
    maxSessionsGlobal: 1000
  });

  assert.equal(uiSessionStore.resolve(first.token, { userAgent: 'cap-agent' }).session, null);
  assert.ok(uiSessionStore.resolve(second.token, { userAgent: 'cap-agent' }).session);
  assert.ok(uiSessionStore.resolve(third.token, { userAgent: 'cap-agent' }).session);

  uiSessionStore.revoke(second.token);
  uiSessionStore.revoke(third.token);
});

test('ui session store applies idle timeout and user-agent binding', async () => {
  const issued = uiSessionStore.issue('tenant-idle', 120, { userAgent: 'bound-agent' });

  const mismatch = uiSessionStore.resolve(issued.token, {
    userAgent: 'another-agent',
    maxIdleSeconds: 120,
    touch: false
  });

  assert.equal(mismatch.session, null);
  assert.equal(mismatch.reason, 'user_agent_mismatch');

  const reissued = uiSessionStore.issue('tenant-idle', 120, { userAgent: 'bound-agent' });

  await new Promise((resolve) => setTimeout(resolve, 1100));

  const idleExpired = uiSessionStore.resolve(reissued.token, {
    userAgent: 'bound-agent',
    maxIdleSeconds: 1,
    touch: false
  });

  assert.equal(idleExpired.session, null);
  assert.equal(idleExpired.reason, 'idle_timeout');
});
