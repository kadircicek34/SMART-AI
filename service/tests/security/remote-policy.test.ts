import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

let remotePolicyModule: typeof import('../../rag/remote-policy.js');

before(async () => {
  process.env.RAG_REMOTE_POLICY_FILE = `/tmp/smart-ai-test-rag-remote-policy-security-${process.pid}.json`;
  process.env.RAG_REMOTE_POLICY_DEFAULT_MODE = 'preview_only';
  process.env.RAG_REMOTE_POLICY_DEFAULT_ALLOWED_HOSTS = 'docs.example.com';

  await fs.writeFile(
    process.env.RAG_REMOTE_POLICY_FILE,
    JSON.stringify(
      {
        tenants: {
          'tenant-allowlist': {
            mode: 'allowlist_only',
            allowedHosts: ['example.com', '*.docs.example.com', '93.184.216.34'],
            updatedAt: new Date().toISOString()
          }
        }
      },
      null,
      2
    ),
    'utf8'
  );

  remotePolicyModule = await import('../../rag/remote-policy.js');
});

test('validateTenantRemotePolicyInput normalizes unicode hosts and dedupes wildcard rules', () => {
  const result = remotePolicyModule.validateTenantRemotePolicyInput({
    mode: 'allowlist_only',
    allowedHosts: ['BÜCHER.de', '*.Docs.Example.com', '*.docs.example.com']
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.allowedHosts, ['xn--bcher-kva.de', '*.docs.example.com']);
  }
});

test('validateTenantRemotePolicyInput rejects unsafe private-network host entries', () => {
  const result = remotePolicyModule.validateTenantRemotePolicyInput({
    mode: 'allowlist_only',
    allowedHosts: ['127.0.0.1']
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'invalid_allowed_host');
  }
});

test('getEffectiveTenantRemotePolicy inherits deployment preview-only defaults', async () => {
  const policy = await remotePolicyModule.getEffectiveTenantRemotePolicy('tenant-default');

  assert.equal(policy.source, 'deployment');
  assert.equal(policy.policyStatus, 'inherited');
  assert.equal(policy.mode, 'preview_only');
  assert.deepEqual(policy.allowedHosts, ['docs.example.com']);
});

test('evaluateTenantRemoteUrlPolicy matches exact, wildcard, and unmatched hosts correctly', async () => {
  const exact = await remotePolicyModule.evaluateTenantRemoteUrlPolicy('tenant-allowlist', 'https://example.com/guide');
  assert.equal(exact.hostname, 'example.com');
  assert.equal(exact.ingestAllowed, true);
  assert.equal(exact.reason, 'allowlist_match');
  assert.equal(exact.matchedHostRule, 'example.com');

  const wildcard = await remotePolicyModule.evaluateTenantRemoteUrlPolicy(
    'tenant-allowlist',
    'https://api.docs.example.com/reference'
  );
  assert.equal(wildcard.hostname, 'api.docs.example.com');
  assert.equal(wildcard.ingestAllowed, true);
  assert.equal(wildcard.matchedHostRule, '*.docs.example.com');

  const ip = await remotePolicyModule.evaluateTenantRemoteUrlPolicy('tenant-allowlist', 'https://93.184.216.34/start');
  assert.equal(ip.hostname, '93.184.216.34');
  assert.equal(ip.ingestAllowed, true);
  assert.equal(ip.matchedHostRule, '93.184.216.34');

  const denied = await remotePolicyModule.evaluateTenantRemoteUrlPolicy('tenant-allowlist', 'https://evil.example.com/phish');
  assert.equal(denied.previewAllowed, true);
  assert.equal(denied.ingestAllowed, false);
  assert.equal(denied.reason, 'host_not_in_allowlist');
  assert.equal(denied.matchedHostRule, null);
});
