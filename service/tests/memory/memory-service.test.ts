import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import {
  __private__,
  autoCaptureUserMemory,
  deleteTenantMemory,
  getTenantMemoryStats,
  listTenantMemories,
  memorizeForTenant,
  searchTenantMemories
} from '../../memory/service.js';

let memoryStoreFile = '';
const originalStoreFile = config.memory.storeFile;
const originalAutoCapture = config.memory.autoCaptureUserMessages;

before(async () => {
  memoryStoreFile = path.join('/tmp', `smart-ai-memory-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  config.memory.storeFile = memoryStoreFile;
  config.memory.autoCaptureUserMessages = true;
});

after(async () => {
  config.memory.storeFile = originalStoreFile;
  config.memory.autoCaptureUserMessages = originalAutoCapture;
  await fs.rm(memoryStoreFile, { force: true });
});

test('memorize + search retrieves preference memory', async () => {
  await memorizeForTenant({
    tenantId: 'tenant-memory-a',
    items: [
      {
        content: 'Ben filtre kahveyi şeker olmadan içmeyi tercih ederim.',
        source: 'unit-test'
      }
    ]
  });

  const result = await searchTenantMemories({
    tenantId: 'tenant-memory-a',
    query: 'Benim kahve tercihim neydi, hatırla',
    limit: 5
  });

  assert.equal(result.decision.decision, 'RETRIEVE');
  assert.ok(result.hits.length >= 1);
  assert.equal(result.hits[0]?.category, 'preference');
});

test('memory search decision returns NO_RETRIEVE for greeting', async () => {
  const result = await searchTenantMemories({
    tenantId: 'tenant-memory-a',
    query: 'selam',
    limit: 5
  });

  assert.equal(result.decision.decision, 'NO_RETRIEVE');
  assert.equal(result.hits.length, 0);
});

test('memory layer enforces tenant isolation and delete flow', async () => {
  const ingest = await memorizeForTenant({
    tenantId: 'tenant-memory-b',
    items: [{ content: 'Toplantı salı günü saat 10:00', category: 'event' }]
  });

  const otherTenant = await searchTenantMemories({
    tenantId: 'tenant-memory-c',
    query: 'salı günü toplantı',
    forceRetrieve: true
  });

  assert.equal(otherTenant.hits.length, 0);

  const removed = await deleteTenantMemory({
    tenantId: 'tenant-memory-b',
    memoryId: ingest.memoryIds[0]
  });

  assert.equal(removed.removed, true);

  const listed = await listTenantMemories({ tenantId: 'tenant-memory-b', limit: 10 });
  assert.equal(listed.length, 0);
});

test('auto capture stores user message when memory-worthy', async () => {
  const captured = await autoCaptureUserMemory({
    tenantId: 'tenant-memory-auto',
    message: 'Benim favori editörüm VSCode ve terminalde zsh kullanıyorum.'
  });

  assert.equal(captured.captured, true);

  const listed = await listTenantMemories({ tenantId: 'tenant-memory-auto', limit: 5 });
  assert.ok(listed.length >= 1);
});

test('memory stats track retrieval metrics', async () => {
  await memorizeForTenant({
    tenantId: 'tenant-metrics',
    items: [{ content: 'Ben her sabah önce task.md dosyasını kontrol ederim.', category: 'habit' }]
  });

  await searchTenantMemories({
    tenantId: 'tenant-metrics',
    query: 'Benim sabah alışkanlığımı hatırla',
    forceRetrieve: true
  });

  const stats = await getTenantMemoryStats('tenant-metrics');
  assert.ok(stats.retrieval.totalQueries >= 1);
  assert.ok(stats.retrieval.totalResults >= 1);
  assert.ok(stats.retrieval.avgLatencyMs >= 0);
});

test('memory system builds related memory links (agentic memory style)', async () => {
  await memorizeForTenant({
    tenantId: 'tenant-memory-links',
    items: [
      { content: 'BIST şirketlerinde bilanço analizi yapıyorum ve finansal oran hesaplıyorum', category: 'knowledge' },
      { content: 'Bilanço analizi sırasında nakit akış ve finansal oran verilerini karşılaştırıyorum', category: 'knowledge' }
    ]
  });

  const listed = await listTenantMemories({ tenantId: 'tenant-memory-links', limit: 10 });
  const withLinks = listed.filter((item) => (item.relatedMemoryIds?.length ?? 0) > 0);

  assert.ok(withLinks.length >= 1);
});

test('hotness score increases with retrieval count and recency', () => {
  const now = Date.now();
  const recentHot = __private__.computeHotnessScore({
    retrievalCount: 30,
    updatedAt: now - 60 * 60 * 1000,
    nowMs: now,
    halfLifeDays: 7
  });

  const oldCold = __private__.computeHotnessScore({
    retrievalCount: 1,
    updatedAt: now - 40 * 24 * 60 * 60 * 1000,
    nowMs: now,
    halfLifeDays: 7
  });

  assert.ok(recentHot > oldCold);
  assert.ok(recentHot <= 1);
  assert.ok(oldCold >= 0);
});
