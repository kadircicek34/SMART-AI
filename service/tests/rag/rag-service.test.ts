import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import {
  deleteTenantDocument,
  ingestDocumentsForTenant,
  ingestUrlForTenant,
  listTenantDocuments,
  previewUrlForTenant,
  searchTenantKnowledge
} from '../../rag/service.js';

let tempStoreFile = '';
let originalStoreFile = '';
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  originalStoreFile = config.rag.storeFile;
  tempStoreFile = path.join('/tmp', `smart-ai-rag-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  config.rag.storeFile = tempStoreFile;
});

afterEach(async () => {
  config.rag.storeFile = originalStoreFile;
  globalThis.fetch = originalFetch;
  await fs.rm(tempStoreFile, { force: true });
});

test('ingests tenant documents and retrieves relevant chunks', async () => {
  const ingest = await ingestDocumentsForTenant({
    tenantId: 'tenant-a',
    documents: [
      {
        title: 'SMART-AI API',
        source: 'local://docs/api.md',
        content:
          'SMART-AI supports OpenAI-compatible chat completions endpoint at /v1/chat/completions and model listing at /v1/models.'
      }
    ]
  });

  assert.equal(ingest.ingestedDocuments, 1);
  assert.ok(ingest.ingestedChunks >= 1);

  const hits = await searchTenantKnowledge({
    tenantId: 'tenant-a',
    query: 'chat completions endpoint',
    limit: 3
  });

  assert.ok(hits.length > 0);
  assert.equal(hits[0]?.documentId, ingest.documentIds[0]);
  assert.match(hits[0]?.content ?? '', /chat completions/i);
});

test('enforces tenant isolation for retrieval', async () => {
  await ingestDocumentsForTenant({
    tenantId: 'tenant-a',
    documents: [
      {
        title: 'Private Notes',
        source: 'local://private.txt',
        content: 'Only tenant-a should see this note.'
      }
    ]
  });

  const tenantBHits = await searchTenantKnowledge({
    tenantId: 'tenant-b',
    query: 'private note',
    limit: 5
  });

  assert.equal(tenantBHits.length, 0);
});

test('lists and deletes tenant documents', async () => {
  const ingest = await ingestDocumentsForTenant({
    tenantId: 'tenant-a',
    documents: [
      {
        documentId: 'doc-to-delete',
        title: 'Delete Me',
        source: 'local://delete.md',
        content: 'temporary content for deletion test'
      }
    ]
  });

  assert.equal(ingest.documentIds[0], 'doc-to-delete');

  const listedBefore = await listTenantDocuments({ tenantId: 'tenant-a' });
  assert.ok(listedBefore.some((doc) => doc.documentId === 'doc-to-delete'));

  const deleted = await deleteTenantDocument({ tenantId: 'tenant-a', documentId: 'doc-to-delete' });
  assert.equal(deleted.removed, true);

  const listedAfter = await listTenantDocuments({ tenantId: 'tenant-a' });
  assert.ok(!listedAfter.some((doc) => doc.documentId === 'doc-to-delete'));
});

test('previews and ingests remote URLs with final URL metadata', async () => {
  const responses = [
    new Response(null, {
      status: 301,
      headers: {
        location: 'https://93.184.216.34/final-guide'
      }
    }),
    new Response('<html><title>Guide</title><body>Remote URL ingest preview is working securely.</body></html>', {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8'
      }
    }),
    new Response(null, {
      status: 301,
      headers: {
        location: 'https://93.184.216.34/final-guide'
      }
    }),
    new Response('<html><title>Guide</title><body>Remote URL ingest preview is working securely.</body></html>', {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8'
      }
    })
  ];

  globalThis.fetch = (async () => responses.shift() ?? new Response('missing response', { status: 500 })) as typeof fetch;

  const preview = await previewUrlForTenant({
    tenantId: 'tenant-a',
    url: 'https://93.184.216.34/start-guide'
  });

  assert.equal(preview.finalUrl, 'https://93.184.216.34/final-guide');
  assert.equal(preview.title, 'Guide');
  assert.match(preview.excerpt, /working securely/i);

  const ingest = await ingestUrlForTenant({
    tenantId: 'tenant-a',
    url: 'https://93.184.216.34/start-guide'
  });

  assert.equal(ingest.remoteUrl.finalUrl, 'https://93.184.216.34/final-guide');
  assert.ok(ingest.ingestedChunks >= 1);

  const docs = await listTenantDocuments({ tenantId: 'tenant-a' });
  assert.ok(docs.some((doc) => doc.source === 'https://93.184.216.34/final-guide'));
});
