import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import {
  deleteTenantDocument,
  ingestDocumentsForTenant,
  listTenantDocuments,
  searchTenantKnowledge
} from '../../rag/service.js';

let tempStoreFile = '';
let originalStoreFile = '';

beforeEach(async () => {
  originalStoreFile = config.rag.storeFile;
  tempStoreFile = path.join('/tmp', `smart-ai-rag-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  config.rag.storeFile = tempStoreFile;
});

afterEach(async () => {
  config.rag.storeFile = originalStoreFile;
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
