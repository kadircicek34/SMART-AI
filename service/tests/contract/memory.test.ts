import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let memoryStoreFile = '';

before(async () => {
  process.env.APP_API_KEYS = 'test-api-key';
  process.env.KEY_STORE_FILE = '/tmp/smart-ai-test-keys-memory-route.json';
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 3).toString('base64');

  memoryStoreFile = path.join('/tmp', `smart-ai-memory-route-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);

  const configMod = await import('../../config.js');
  configMod.config.memory.storeFile = memoryStoreFile;
  configMod.config.memory.autoCaptureUserMessages = false;

  const mod = await import('../../api/app.js');
  app = mod.buildApp();
});

after(async () => {
  await app.close();
  await fs.rm(memoryStoreFile, { force: true });
});

test('memory ingest + search endpoints work for tenant', async () => {
  const ingest = await app.inject({
    method: 'POST',
    url: '/v1/memory/items',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-memory-route',
      'content-type': 'application/json'
    },
    payload: {
      items: [
        {
          content: 'Ben toplantıları sabah 10:00 ile 12:00 arasında yapmayı tercih ederim.',
          category: 'preference'
        }
      ]
    }
  });

  assert.equal(ingest.statusCode, 200);
  const ingestBody = ingest.json();
  assert.equal(ingestBody.object, 'memory.memorize');
  assert.equal(ingestBody.stored, 1);

  const search = await app.inject({
    method: 'POST',
    url: '/v1/memory/search',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-memory-route',
      'content-type': 'application/json'
    },
    payload: {
      query: 'Benim toplantı tercihim neydi, hatırla'
    }
  });

  assert.equal(search.statusCode, 200);
  const searchBody = search.json();
  assert.equal(searchBody.object, 'list');
  assert.equal(searchBody.decision.decision, 'RETRIEVE');
  assert.ok(searchBody.data.length > 0);
});

test('memory search is tenant isolated', async () => {
  const search = await app.inject({
    method: 'POST',
    url: '/v1/memory/search',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-memory-other',
      'content-type': 'application/json'
    },
    payload: {
      query: 'Benim toplantı tercihim neydi, hatırla',
      force_retrieve: true
    }
  });

  assert.equal(search.statusCode, 200);
  const body = search.json();
  assert.equal(body.object, 'list');
  assert.equal(body.data.length, 0);
});
