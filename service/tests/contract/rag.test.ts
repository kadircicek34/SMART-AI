import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let ragStoreFile = '';

before(async () => {
  process.env.APP_API_KEYS = 'test-api-key';
  process.env.KEY_STORE_FILE = '/tmp/smart-ai-test-keys-rag-route.json';
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');

  ragStoreFile = path.join('/tmp', `smart-ai-rag-route-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);

  const configMod = await import('../../config.js');
  configMod.config.rag.storeFile = ragStoreFile;

  const mod = await import('../../api/app.js');
  app = mod.buildApp();
});

after(async () => {
  await app.close();
  await fs.rm(ragStoreFile, { force: true });
});

test('RAG ingest + search endpoints work for tenant', async () => {
  const ingest = await app.inject({
    method: 'POST',
    url: '/v1/rag/documents',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-rag',
      'content-type': 'application/json'
    },
    payload: {
      documents: [
        {
          title: 'API Docs',
          content: 'SMART-AI provides /v1/chat/completions and /v1/models endpoints.'
        }
      ]
    }
  });

  assert.equal(ingest.statusCode, 200);
  const ingestBody = ingest.json();
  assert.equal(ingestBody.object, 'rag.ingest');
  assert.equal(ingestBody.ingestedDocuments, 1);

  const search = await app.inject({
    method: 'POST',
    url: '/v1/rag/search',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-rag',
      'content-type': 'application/json'
    },
    payload: {
      query: 'chat completions endpoint'
    }
  });

  assert.equal(search.statusCode, 200);
  const searchBody = search.json();
  assert.equal(searchBody.object, 'list');
  assert.ok(Array.isArray(searchBody.data));
  assert.ok(searchBody.data.length > 0);
});

test('RAG search is tenant isolated', async () => {
  const search = await app.inject({
    method: 'POST',
    url: '/v1/rag/search',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-empty',
      'content-type': 'application/json'
    },
    payload: {
      query: 'chat completions endpoint'
    }
  });

  assert.equal(search.statusCode, 200);
  const body = search.json();
  assert.equal(body.object, 'list');
  assert.equal(body.data.length, 0);
});
