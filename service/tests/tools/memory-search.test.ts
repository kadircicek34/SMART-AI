import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { memorizeForTenant } from '../../memory/service.js';
import { memorySearchTool } from '../../tools/memory-search.js';

let memoryStoreFile = '';
const originalStoreFile = config.memory.storeFile;

before(async () => {
  memoryStoreFile = path.join('/tmp', `smart-ai-memory-tool-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  config.memory.storeFile = memoryStoreFile;

  await memorizeForTenant({
    tenantId: 'tenant-memory-tool',
    items: [
      {
        content: 'Ben code review yaparken önce test raporuna bakarım.',
        category: 'habit',
        source: 'unit-test'
      }
    ]
  });
});

after(async () => {
  config.memory.storeFile = originalStoreFile;
  await fs.rm(memoryStoreFile, { force: true });
});

test('memory_search returns memory citations for retrieve-worthy query', async () => {
  const result = await memorySearchTool.execute({
    tenantId: 'tenant-memory-tool',
    query: 'Benim code review alışkanlığımı hatırla'
  });

  assert.equal(result.tool, 'memory_search');
  assert.ok(result.citations.some((citation) => citation.startsWith('memory://tenant-memory-tool/')));
  assert.match(result.summary, /score=/);
});
