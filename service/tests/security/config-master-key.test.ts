import { test } from 'node:test';
import assert from 'node:assert/strict';

const CONFIG_MODULE_PATH = new URL('../../config.ts', import.meta.url).pathname;

async function importConfigFresh() {
  return import(`${CONFIG_MODULE_PATH}?t=${Date.now()}-${Math.random()}`);
}

async function withEnv<T>(env: { nodeEnv?: string; masterKeyBase64?: string }, fn: () => Promise<T>): Promise<T> {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevMasterKey = process.env.MASTER_KEY_BASE64;

  if (env.nodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = env.nodeEnv;
  }

  if (env.masterKeyBase64 === undefined) {
    delete process.env.MASTER_KEY_BASE64;
  } else {
    process.env.MASTER_KEY_BASE64 = env.masterKeyBase64;
  }

  try {
    return await fn();
  } finally {
    if (prevNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = prevNodeEnv;
    }

    if (prevMasterKey === undefined) {
      delete process.env.MASTER_KEY_BASE64;
    } else {
      process.env.MASTER_KEY_BASE64 = prevMasterKey;
    }
  }
}

test('config accepts dev fallback master key outside production', async () => {
  await withEnv({ nodeEnv: 'development', masterKeyBase64: undefined }, async () => {
    const mod = await importConfigFresh();
    assert.equal(mod.config.security.masterKey.length, 32);
  });
});

test('config fails fast in production when MASTER_KEY_BASE64 is missing', async () => {
  await withEnv({ nodeEnv: 'production', masterKeyBase64: undefined }, async () => {
    await assert.rejects(() => importConfigFresh(), /MASTER_KEY_BASE64 is required in production/);
  });
});

test('config fails fast in production when MASTER_KEY_BASE64 is invalid', async () => {
  await withEnv(
    { nodeEnv: 'production', masterKeyBase64: Buffer.alloc(16, 1).toString('base64') },
    async () => {
      await assert.rejects(
        () => importConfigFresh(),
        /Invalid MASTER_KEY_BASE64: expected base64-encoded key with at least 32 bytes/
      );
    }
  );
});
