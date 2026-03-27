import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let ragStoreFile = '';
const originalFetch = globalThis.fetch;

before(async () => {
  process.env.APP_API_KEYS = 'test-api-key';
  process.env.KEY_STORE_FILE = '/tmp/smart-ai-test-keys-rag-route.json';
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');

  ragStoreFile = path.join('/tmp', `smart-ai-rag-route-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);

  const configMod = await import('../../config.js');
  configMod.config.rag.storeFile = ragStoreFile;
  configMod.config.rag.remoteFetchMaxBytes = 32_768;
  configMod.config.rag.remoteFetchMaxRedirects = 3;
  configMod.config.rag.remoteAllowedPorts = [80, 443];
  configMod.config.rag.remoteAllowedContentTypes = ['text/plain', 'text/html', 'application/json', 'application/xml', 'text/xml'];

  const mod = await import('../../api/app.js');
  app = mod.buildApp();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(async () => {
  globalThis.fetch = originalFetch;
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

test('RAG URL preview returns safe metadata before ingest', async () => {
  globalThis.fetch = (async () =>
    new Response('<html><title>Preview Title</title><body>SMART-AI remote ingest docs</body></html>', {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8'
      }
    })) as typeof fetch;

  const preview = await app.inject({
    method: 'POST',
    url: '/v1/rag/url-preview',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-preview',
      'content-type': 'application/json'
    },
    payload: {
      url: 'https://93.184.216.34/docs'
    }
  });

  assert.equal(preview.statusCode, 200);
  const body = preview.json();
  assert.equal(body.object, 'rag.url_preview');
  assert.equal(body.final_url, 'https://93.184.216.34/docs');
  assert.equal(body.title, 'Preview Title');
  assert.equal(body.content_type, 'text/html');
  assert.ok(body.content_length_bytes > 0);
  assert.match(body.excerpt, /SMART-AI remote ingest docs/i);
  assert.equal(body.excerpt_truncated, false);
});

test('RAG URL ingest returns remote metadata and searchable content', async () => {
  const responses = [
    new Response(null, {
      status: 302,
      headers: {
        location: 'https://93.184.216.34/final-doc'
      }
    }),
    new Response('<html><title>Remote Doc</title><body>Secure remote RAG ingestion is enabled.</body></html>', {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8'
      }
    })
  ];

  globalThis.fetch = (async () => responses.shift() ?? new Response('missing response', { status: 500 })) as typeof fetch;

  const ingest = await app.inject({
    method: 'POST',
    url: '/v1/rag/documents',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-remote',
      'content-type': 'application/json'
    },
    payload: {
      url: 'https://93.184.216.34/start-doc'
    }
  });

  assert.equal(ingest.statusCode, 200);
  const ingestBody = ingest.json();
  assert.equal(ingestBody.object, 'rag.ingest');
  assert.equal(ingestBody.mode, 'url');
  assert.equal(ingestBody.remote_url.final_url, 'https://93.184.216.34/final-doc');
  assert.equal(ingestBody.remote_url.content_type, 'text/html');
  assert.ok(ingestBody.ingestedChunks >= 1);

  const search = await app.inject({
    method: 'POST',
    url: '/v1/rag/search',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-remote',
      'content-type': 'application/json'
    },
    payload: {
      query: 'secure remote ingestion'
    }
  });

  assert.equal(search.statusCode, 200);
  const searchBody = search.json();
  assert.ok(searchBody.data.length > 0);
});

test('RAG URL ingest blocks private-network targets and emits security audit evidence', async () => {
  const blocked = await app.inject({
    method: 'POST',
    url: '/v1/rag/documents',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-preview',
      'content-type': 'application/json'
    },
    payload: {
      url: 'http://127.0.0.1/private'
    }
  });

  assert.equal(blocked.statusCode, 400);
  const blockedBody = blocked.json();
  assert.equal(blockedBody.error.type, 'invalid_request_error');
  assert.match(blockedBody.error.message, /remote_url_private_network_not_allowed/);

  const events = await app.inject({
    method: 'GET',
    url: '/v1/security/events?type=rag_remote_url_blocked&limit=5',
    headers: {
      authorization: 'Bearer test-api-key',
      'x-tenant-id': 'tenant-preview'
    }
  });

  assert.equal(events.statusCode, 200);
  const eventsBody = events.json();
  assert.ok(eventsBody.data.some((event: any) => event.type === 'rag_remote_url_blocked'));
});
