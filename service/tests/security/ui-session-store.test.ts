import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUiSessionStore } from '../../security/ui-session-store.js';

function tempFile(name: string): string {
  return path.join(os.tmpdir(), `smart-ai-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test('ui session store issues and revokes token', () => {
  const store = createUiSessionStore();
  const issued = store.issue('tenant-x', 60);

  const resolved = store.resolve(issued.token);
  assert.ok(resolved.session);
  assert.equal(resolved.session?.tenantId, 'tenant-x');

  const revoked = store.revoke(issued.token);
  assert.equal(revoked, true);
  assert.equal(store.resolve(issued.token).session, null);
});

test('ui session store rotates token and preserves principal scopes', () => {
  const store = createUiSessionStore();
  const issued = store.issue('tenant-rotate', 60, {
    userAgent: 'agent-a',
    principalName: 'ops-user',
    scopes: ['tenant:read', 'tenant:operate']
  });

  const rotated = store.rotate(issued.token, 60, {
    userAgent: 'agent-a',
    maxIdleSeconds: 120,
    maxSessionsPerTenant: 5,
    maxSessionsGlobal: 500
  });

  assert.ok(rotated.session);
  assert.notEqual(rotated.session?.token, issued.token);
  assert.equal(store.resolve(issued.token).session, null);

  const hit = store.resolve(rotated.session!.token, { userAgent: 'agent-a', maxIdleSeconds: 120 });
  assert.ok(hit.session);
  assert.equal(hit.session?.principalName, 'ops-user');
  assert.deepEqual(hit.session?.scopes, ['tenant:read', 'tenant:operate']);

  store.revoke(rotated.session!.token);
});

test('ui session store enforces max sessions per tenant (oldest evicted)', () => {
  const store = createUiSessionStore();
  const first = store.issue('tenant-cap', 120, {
    userAgent: 'cap-agent',
    maxSessionsPerTenant: 2,
    maxSessionsGlobal: 1000
  });
  const second = store.issue('tenant-cap', 120, {
    userAgent: 'cap-agent',
    maxSessionsPerTenant: 2,
    maxSessionsGlobal: 1000
  });
  const third = store.issue('tenant-cap', 120, {
    userAgent: 'cap-agent',
    maxSessionsPerTenant: 2,
    maxSessionsGlobal: 1000
  });

  assert.equal(store.resolve(first.token, { userAgent: 'cap-agent' }).session, null);
  assert.ok(store.resolve(second.token, { userAgent: 'cap-agent' }).session);
  assert.ok(store.resolve(third.token, { userAgent: 'cap-agent' }).session);

  store.revoke(second.token);
  store.revoke(third.token);
});

test('ui session store applies idle timeout and user-agent binding', async () => {
  const store = createUiSessionStore();
  const issued = store.issue('tenant-idle', 120, { userAgent: 'bound-agent' });

  const mismatch = store.resolve(issued.token, {
    userAgent: 'another-agent',
    maxIdleSeconds: 120,
    touch: false
  });

  assert.equal(mismatch.session, null);
  assert.equal(mismatch.reason, 'user_agent_mismatch');

  const reissued = store.issue('tenant-idle', 120, { userAgent: 'bound-agent' });

  await new Promise((resolve) => setTimeout(resolve, 1100));

  const idleExpired = store.resolve(reissued.token, {
    userAgent: 'bound-agent',
    maxIdleSeconds: 1,
    touch: false
  });

  assert.equal(idleExpired.session, null);
  assert.equal(idleExpired.reason, 'idle_timeout');
});

test('ui session store persists hashed sessions across restart without storing plaintext token', async () => {
  const filePath = tempFile('ui-sessions');
  const store = createUiSessionStore({ filePath, persistDebounceMs: 5 });
  const issued = store.issue('tenant-persist', 120, {
    userAgent: 'persist-agent',
    principalName: 'tenant-admin',
    scopes: ['tenant:admin']
  });

  await store.flushPersistedState();

  const raw = await fs.readFile(filePath, 'utf-8');
  assert.equal(raw.includes(issued.token), false);

  const restored = createUiSessionStore({ filePath, persistDebounceMs: 5 });
  const hit = restored.resolve(issued.token, {
    userAgent: 'persist-agent',
    maxIdleSeconds: 120,
    touch: false
  });

  assert.ok(hit.session);
  assert.equal(hit.session?.tenantId, 'tenant-persist');
  assert.equal(hit.session?.principalName, 'tenant-admin');

  await fs.rm(filePath, { force: true });
});

test('ui session store lists tenant sessions and supports revoke-all while preserving current session', () => {
  const store = createUiSessionStore();
  const current = store.issue('tenant-admin', 120, { userAgent: 'dashboard-agent', principalName: 'admin' });
  const other = store.issue('tenant-admin', 120, { userAgent: 'dashboard-agent', principalName: 'operator' });
  const another = store.issue('tenant-admin', 120, { userAgent: 'dashboard-agent', principalName: 'observer' });

  const listed = store.listTenantSessions('tenant-admin', {
    currentToken: current.token,
    maxIdleSeconds: 120,
    limit: 10
  });

  assert.equal(listed.length, 3);
  assert.equal(listed.filter((session) => session.isCurrent).length, 1);
  assert.equal(listed.find((session) => session.isCurrent)?.principalName, 'admin');

  const revokedCount = store.revokeAllForTenant('tenant-admin', {
    exceptCurrentToken: current.token
  });

  assert.equal(revokedCount, 2);
  assert.ok(store.resolve(current.token, { userAgent: 'dashboard-agent' }).session);
  assert.equal(store.resolve(other.token, { userAgent: 'dashboard-agent' }).session, null);
  assert.equal(store.resolve(another.token, { userAgent: 'dashboard-agent' }).session, null);
});
