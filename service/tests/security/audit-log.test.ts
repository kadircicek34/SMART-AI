import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSecurityAuditLog, verifySecurityAuditIntegrity } from '../../security/audit-log.js';

function tempFile(name: string): string {
  return path.join(os.tmpdir(), `smart-ai-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

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

test('security audit log builds tamper-evident hash chain and exports integrity metadata', () => {
  const log = createSecurityAuditLog(10);

  const first = log.record({
    tenant_id: 'tenant-chain',
    type: 'ui_session_issued',
    details: { principal_name: 'dashboard-admin' }
  });
  const second = log.record({
    tenant_id: 'tenant-chain',
    type: 'api_scope_denied',
    details: { required_scope: 'tenant:admin' }
  });

  assert.equal(first.sequence, 1);
  assert.equal(first.prev_chain_hash, null);
  assert.match(first.chain_hash, /^[a-f0-9]{64}$/);
  assert.equal(second.sequence, 2);
  assert.equal(second.prev_chain_hash, first.chain_hash);
  assert.match(second.chain_hash, /^[a-f0-9]{64}$/);

  const summary = log.summarize('tenant-chain', { sinceTimestamp: 0 });
  assert.equal(summary.integrity.verified, true);
  assert.equal(summary.integrity.lastSequence, 2);
  assert.equal(summary.integrity.headChainHash, second.chain_hash);

  const bundle = log.export('tenant-chain', { limit: 10 });
  assert.equal(bundle.data.length, 2);
  assert.equal(bundle.integrity.verified, true);
  assert.equal(bundle.integrity.anchorPrevChainHash, null);
  assert.equal(bundle.integrity.headChainHash, second.chain_hash);
  assert.equal(bundle.filter.truncated, false);
});

test('verifySecurityAuditIntegrity detects tampered exported events', () => {
  const log = createSecurityAuditLog(10);
  log.record({ tenant_id: 'tenant-verify', type: 'ui_session_issued' });
  log.record({ tenant_id: 'tenant-verify', type: 'api_auth_failed', details: { reason: 'invalid_token' } });

  const bundle = log.export('tenant-verify', { limit: 10 });
  const tampered = structuredClone(bundle.data);
  tampered[1].details = { reason: 'tampered' };

  const integrity = verifySecurityAuditIntegrity({
    events: tampered,
    anchorPrevChainHash: bundle.integrity.anchorPrevChainHash
  });

  assert.equal(integrity.verified, false);
  assert.equal(integrity.failureReason, 'chain_hash_mismatch');
  assert.equal(integrity.brokenAtSequence, 2);
});

test('security audit log persists sanitized events across restart', async () => {
  const filePath = tempFile('security-audit');
  const log = createSecurityAuditLog(10, { filePath, persistDebounceMs: 5 });

  log.record({
    tenant_id: 'tenant-persist',
    type: 'ui_auth_failed',
    ip: '127.0.0.1',
    details: {
      authorization: 'Bearer sk-secret-token-value',
      api_key: 'sk-secret-value',
      note: 'invalid credentials'
    }
  });

  await log.flushPersistedState();

  const raw = await fs.readFile(filePath, 'utf-8');
  assert.equal(raw.includes('sk-secret-token-value'), false);
  assert.equal(raw.includes('sk-secret-value'), false);
  assert.match(raw, /"sequence": 1/);
  assert.match(raw, /"chain_hash": "[a-f0-9]{64}"/);

  const restored = createSecurityAuditLog(10, { filePath, persistDebounceMs: 5 });
  const events = restored.list('tenant-persist', { limit: 5 });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'ui_auth_failed');
  assert.equal(events[0].sequence, 1);
  assert.equal(events[0].details?.authorization, 'Bearer [redacted-api-key]');
  assert.equal(events[0].details?.api_key, '[redacted-api-key]');
  assert.match(events[0].chain_hash, /^[a-f0-9]{64}$/);

  await fs.rm(filePath, { force: true });
});
