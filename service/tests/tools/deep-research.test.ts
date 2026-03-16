import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __private__ } from '../../tools/deep-research.js';

test('deep_research query planner caps query count and reports overflow', () => {
  const plan = __private__.buildResearchQueryPlan('SMART-AI agent orchestration roadmap', 2);

  assert.equal(plan.queries.length, 2);
  assert.ok(plan.overflowCount >= 1);
});

test('deep_research continues when one source fails and dedupes citations', async () => {
  const result = await __private__.executeDeepResearch(
    {
      query: 'SMART-AI production hardening',
      tenantId: 'tenant-test'
    },
    {
      memorySearch: {
        execute: async () => ({
          tool: 'memory_search',
          summary: 'memory: kullanıcı geçmiş tercihi bulundu',
          citations: ['memory://tenant-test/mem_1']
        })
      },
      ragSearch: {
        execute: async () => {
          throw new Error('rag backend unavailable');
        }
      },
      webSearch: {
        execute: async ({ query }) => {
          if (query.includes('risks')) {
            throw new Error('temporary web failure');
          }

          return {
            tool: 'web_search',
            summary: `web:${query}`,
            citations: ['https://example.com/shared', `https://web.example/${encodeURIComponent(query)}`]
          };
        }
      },
      wikipedia: {
        execute: async ({ query }) => ({
          tool: 'wikipedia',
          summary: `wiki:${query}`,
          citations: ['https://example.com/shared', `https://wiki.example/${encodeURIComponent(query)}`]
        })
      }
    },
    {
      maxQueries: 4,
      maxConcurrentUnits: 2
    }
  );

  assert.equal(result.tool, 'deep_research');
  assert.match(result.summary, /Tenant Memory:/);
  assert.match(result.summary, /Tenant RAG: hata/);
  assert.match(result.summary, /Web: hata \(temporary web failure\)/);
  assert.ok(result.citations.includes('https://example.com/shared'));

  // dedupe check: shared citation should appear once
  const sharedCount = result.citations.filter((citation) => citation === 'https://example.com/shared').length;
  assert.equal(sharedCount, 1);
});
