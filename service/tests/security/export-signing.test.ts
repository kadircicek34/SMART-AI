import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import {
  createSecurityExportSigningRegistry,
  getSecurityExportJwksPath,
  SecurityExportSigningError,
  type SecurityExportSigningLifecyclePolicy
} from '../../security/export-signing.js';

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPolicy(overrides: Partial<SecurityExportSigningLifecyclePolicy> = {}): SecurityExportSigningLifecyclePolicy {
  return {
    auto_rotate: true,
    rotate_after_hours: 24,
    expire_after_hours: 48,
    warn_before_hours: 12,
    verify_retention_hours: 168,
    ...overrides
  };
}

test('security export signing registry bootstraps active key, rotates, and keeps private key material encrypted at rest', async () => {
  const storeFile = `/tmp/smart-ai-export-signing-registry-${process.pid}-${Date.now()}.json`;
  const registry = createSecurityExportSigningRegistry({
    filePath: storeFile,
    masterKey: Buffer.alloc(32, 9),
    maxVerifyKeys: 1,
    defaultPolicy: buildPolicy(),
    maintenanceIntervalMs: 0
  });

  const initialActive = registry.getActiveKeySummary();
  assert.equal(initialActive.status, 'active');
  assert.equal(registry.getPublicJwks().active_key_id, initialActive.key_id);

  const rotatedActive = await registry.rotate();
  assert.equal(rotatedActive.status, 'active');
  assert.notEqual(rotatedActive.key_id, initialActive.key_id);

  const summaries = registry.listKeySummaries();
  assert.equal(summaries.length, 2);
  assert.equal(summaries.filter((entry) => entry.status === 'active').length, 1);
  assert.equal(summaries.filter((entry) => entry.status === 'verify_only').length, 1);

  const rawStore = await fs.readFile(storeFile, 'utf8');
  assert.match(rawStore, /"private_jwk"/);
  assert.ok(!rawStore.includes('"d":'));

  const jwks = registry.getPublicJwks();
  assert.equal(jwks.object, 'jwks');
  assert.equal(jwks.active_key_id, rotatedActive.key_id);
  assert.equal(jwks.keys.length, 2);
  assert.ok(jwks.keys.every((key) => key.alg === 'EdDSA'));
});

test('security export signing registry produces and verifies detached Ed25519 signatures', async () => {
  const storeFile = `/tmp/smart-ai-export-signing-verify-${process.pid}-${Date.now()}.json`;
  const registry = createSecurityExportSigningRegistry({
    filePath: storeFile,
    masterKey: Buffer.alloc(32, 11),
    maxVerifyKeys: 2,
    defaultPolicy: buildPolicy(),
    maintenanceIntervalMs: 0
  });

  const payload = JSON.stringify({ object: 'security_audit_export', marker: 'detached-signature-check' });
  const signing = registry.signDetachedText(payload);
  const verification = registry.verifyDetachedText(payload, {
    algorithm: 'Ed25519',
    key_id: signing.key_id,
    signed_at: signing.signed_at,
    payload_sha256: sha256Hex(payload),
    signature: signing.signature,
    public_keys_url: getSecurityExportJwksPath()
  });

  assert.equal(verification.verified, true);
  assert.equal(verification.reason, undefined);

  const tampered = registry.verifyDetachedText(`${payload}-tampered`, {
    algorithm: 'Ed25519',
    key_id: signing.key_id,
    signed_at: signing.signed_at,
    payload_sha256: sha256Hex(payload),
    signature: signing.signature,
    public_keys_url: getSecurityExportJwksPath()
  });

  assert.equal(tampered.verified, false);
  assert.equal(tampered.reason, 'payload_sha256_mismatch');
});

test('security export signing registry auto-rotates overdue active key before signing when lifecycle policy requires it', async () => {
  const storeFile = `/tmp/smart-ai-export-signing-auto-rotate-${process.pid}-${Date.now()}.json`;
  const registry = createSecurityExportSigningRegistry({
    filePath: storeFile,
    masterKey: Buffer.alloc(32, 17),
    maxVerifyKeys: 3,
    defaultPolicy: buildPolicy({
      auto_rotate: true,
      rotate_after_hours: 1 / 3600,
      expire_after_hours: 1,
      warn_before_hours: 0.5,
      verify_retention_hours: 24
    }),
    maintenanceIntervalMs: 0
  });

  const initialActive = registry.getActiveKeySummary();
  await sleep(1200);

  const signing = registry.signDetachedText(JSON.stringify({ marker: 'auto-rotate' }));
  const nextActive = registry.getActiveKeySummary();
  const keys = registry.listKeySummaries();

  assert.notEqual(nextActive.key_id, initialActive.key_id);
  assert.equal(signing.key_id, nextActive.key_id);
  assert.equal(keys.filter((entry) => entry.status === 'active').length, 1);
  assert.equal(keys.filter((entry) => entry.status === 'verify_only').length, 1);
});

test('security export signing registry prunes verify-only keys past retention window', async () => {
  const storeFile = `/tmp/smart-ai-export-signing-prune-${process.pid}-${Date.now()}.json`;
  const registry = createSecurityExportSigningRegistry({
    filePath: storeFile,
    masterKey: Buffer.alloc(32, 21),
    maxVerifyKeys: 4,
    defaultPolicy: buildPolicy({
      auto_rotate: false,
      rotate_after_hours: 24,
      expire_after_hours: 48,
      warn_before_hours: 12,
      verify_retention_hours: 1 / 3600
    }),
    maintenanceIntervalMs: 0
  });

  const initialActive = registry.getActiveKeySummary();
  const rotatedActive = await registry.rotate();
  assert.notEqual(rotatedActive.key_id, initialActive.key_id);
  assert.equal(registry.listKeySummaries().length, 2);

  await sleep(1200);
  const summaries = registry.listKeySummaries();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.key_id, rotatedActive.key_id);
  assert.equal(summaries[0]?.status, 'active');
});

test('security export signing registry blocks signing with an expired active key when auto-rotation is disabled', async () => {
  const storeFile = `/tmp/smart-ai-export-signing-expired-${process.pid}-${Date.now()}.json`;
  const registry = createSecurityExportSigningRegistry({
    filePath: storeFile,
    masterKey: Buffer.alloc(32, 25),
    maxVerifyKeys: 2,
    defaultPolicy: buildPolicy({
      auto_rotate: false,
      rotate_after_hours: 1 / 3600,
      expire_after_hours: 2 / 3600,
      warn_before_hours: 1 / 3600,
      verify_retention_hours: 24
    }),
    maintenanceIntervalMs: 0
  });

  await sleep(2200);
  assert.throws(
    () => registry.signDetachedText(JSON.stringify({ marker: 'expired-key' })),
    (error: unknown) =>
      error instanceof SecurityExportSigningError &&
      error.code === 'active_key_expired' &&
      /expired/i.test(error.message)
  );
});

test('security export signing maintenance dry-run previews actions without mutating active key', async () => {
  const storeFile = `/tmp/smart-ai-export-signing-maintenance-dry-run-${process.pid}-${Date.now()}.json`;
  const registry = createSecurityExportSigningRegistry({
    filePath: storeFile,
    masterKey: Buffer.alloc(32, 27),
    maxVerifyKeys: 2,
    defaultPolicy: buildPolicy({
      auto_rotate: true,
      rotate_after_hours: 1 / 3600,
      expire_after_hours: 1,
      warn_before_hours: 0.5,
      verify_retention_hours: 24
    }),
    maintenanceIntervalMs: 0,
    maintenanceLeaseTtlMs: 5_000,
    maintenanceHistoryLimit: 8
  });

  const initialActiveKeyId = registry.getActiveKeySummary().key_id;
  const initialMaintenance = registry.getMaintenanceState();
  await sleep(1200);

  const preview = registry.runMaintenanceNow({ dryRun: true });
  assert.equal(preview.dry_run, true);
  assert.equal(preview.changed, false);
  assert.equal(preview.skipped_reason, 'dry_run');
  assert.ok(preview.actions.includes('rotate_due_active_key'));
  assert.equal(registry.getActiveKeySummary().key_id, initialActiveKeyId);

  const maintenance = registry.getMaintenanceState();
  assert.equal(maintenance.last_run?.run_id, initialMaintenance.last_run?.run_id);
  assert.equal(maintenance.history.length, initialMaintenance.history.length);
});

test('security export signing registries sharing one store sync rotated active key and maintenance history across instances', async () => {
  const storeFile = `/tmp/smart-ai-export-signing-shared-${process.pid}-${Date.now()}.json`;
  const registryA = createSecurityExportSigningRegistry({
    filePath: storeFile,
    masterKey: Buffer.alloc(32, 31),
    maxVerifyKeys: 3,
    defaultPolicy: buildPolicy({
      auto_rotate: true,
      rotate_after_hours: 1 / 3600,
      expire_after_hours: 1,
      warn_before_hours: 0.5,
      verify_retention_hours: 24
    }),
    maintenanceIntervalMs: 0,
    maintenanceLeaseTtlMs: 30_000,
    maintenanceHistoryLimit: 8
  });
  const registryB = createSecurityExportSigningRegistry({
    filePath: storeFile,
    masterKey: Buffer.alloc(32, 31),
    maxVerifyKeys: 3,
    defaultPolicy: buildPolicy({
      auto_rotate: true,
      rotate_after_hours: 1 / 3600,
      expire_after_hours: 1,
      warn_before_hours: 0.5,
      verify_retention_hours: 24
    }),
    maintenanceIntervalMs: 0,
    maintenanceLeaseTtlMs: 30_000,
    maintenanceHistoryLimit: 8
  });

  const initialKeyId = registryA.getActiveKeySummary().key_id;
  assert.equal(registryB.getActiveKeySummary().key_id, initialKeyId);

  await sleep(1200);
  const signature = registryA.signDetachedText(JSON.stringify({ marker: 'shared-maintenance-sync' }));
  assert.notEqual(signature.key_id, initialKeyId);

  const activeFromB = registryB.getActiveKeySummary();
  assert.equal(activeFromB.key_id, signature.key_id);
  assert.equal(registryB.signDetachedText(JSON.stringify({ marker: 'shared-second-sign' })).key_id, signature.key_id);

  const maintenanceState = registryB.getMaintenanceState();
  assert.equal(maintenanceState.last_run?.changed, true);
  assert.ok(maintenanceState.last_run?.actions.includes('rotate_due_active_key'));
  assert.equal(maintenanceState.leader.holder_id, maintenanceState.history[0]?.lease.holder_id ?? maintenanceState.leader.holder_id);
});
