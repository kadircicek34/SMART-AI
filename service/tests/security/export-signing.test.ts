import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createSecurityExportSigningRegistry, getSecurityExportJwksPath } from '../../security/export-signing.js';

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

test('security export signing registry bootstraps active key, rotates, and keeps private key material encrypted at rest', async () => {
  const storeFile = `/tmp/smart-ai-export-signing-registry-${process.pid}-${Date.now()}.json`;
  const registry = createSecurityExportSigningRegistry({
    filePath: storeFile,
    masterKey: Buffer.alloc(32, 9),
    maxVerifyKeys: 1
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
    maxVerifyKeys: 2
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
