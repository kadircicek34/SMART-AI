import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

let api: {
  setTenantOpenRouterKey: (tenantId: string, apiKey: string) => Promise<void>;
  getTenantOpenRouterKey: (tenantId: string) => Promise<string | null>;
  deleteTenantOpenRouterKey: (tenantId: string) => Promise<boolean>;
  hasTenantOpenRouterKey: (tenantId: string) => Promise<boolean>;
  validateOpenRouterKeyShape: (apiKey: string) => boolean;
};

const file = '/tmp/smart-ai-test-keystore.json';

before(async () => {
  process.env.KEY_STORE_FILE = file;
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 11).toString('base64');

  try {
    await fs.unlink(file);
  } catch {
    // ignore
  }

  api = await import('../../security/key-store.js');
});

test('key format validation', () => {
  assert.equal(api.validateOpenRouterKeyShape('abc'), false);
  assert.equal(api.validateOpenRouterKeyShape('sk-or-v1-1234567890123456789012'), true);
});

test('store/get/delete key roundtrip', async () => {
  const tenant = 'tenant-a';
  const key = 'sk-or-v1-123456789012345678901234567890';

  await api.setTenantOpenRouterKey(tenant, key);
  assert.equal(await api.hasTenantOpenRouterKey(tenant), true);
  assert.equal(await api.getTenantOpenRouterKey(tenant), key);

  const removed = await api.deleteTenantOpenRouterKey(tenant);
  assert.equal(removed, true);
  assert.equal(await api.hasTenantOpenRouterKey(tenant), false);
});
