import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __private__ } from '../../tools/qmd-search.js';

test('qmd_search auto-adds missing collection and returns formatted results', async () => {
  const calls: string[][] = [];

  const runner = async (args: string[]) => {
    calls.push(args);

    if (args[0] === 'collection' && args[1] === 'list') {
      return {
        stdout: 'No collections found. Run qmd collection add .',
        stderr: ''
      };
    }

    if (args[0] === 'collection' && args[1] === 'add') {
      return {
        stdout: "Collection 'SMART-AI' created",
        stderr: ''
      };
    }

    if (args[0] === 'search') {
      return {
        stdout: JSON.stringify([
          {
            docid: '#a1',
            score: 0.91,
            file: 'qmd://SMART-AI/README.md',
            title: 'SMART-AI README',
            snippet: 'QMD integration details and setup information.'
          }
        ]),
        stderr: ''
      };
    }

    throw new Error(`unexpected command: ${args.join(' ')}`);
  };

  const result = await __private__.executeQmdSearchWithRunner(
    {
      query: 'smart-ai qmd entegrasyonu',
      tenantId: 'tenant-test'
    },
    runner,
    {
      enabled: true,
      collectionName: 'SMART-AI',
      collectionPath: '/tmp/SMART-AI',
      autoAddCollection: true,
      maxResults: 5,
      maxSnippetChars: 120
    }
  );

  assert.equal(result.tool, 'qmd_search');
  assert.match(result.summary, /SMART-AI README/);
  assert.ok(result.citations.includes('qmd://SMART-AI/README.md'));

  const calledAdd = calls.some((cmd) => cmd[0] === 'collection' && cmd[1] === 'add');
  assert.equal(calledAdd, true);
});

test('qmd_search returns disabled summary when feature is off', async () => {
  const result = await __private__.executeQmdSearchWithRunner(
    {
      query: 'smart-ai qmd entegrasyonu',
      tenantId: 'tenant-test'
    },
    async () => {
      throw new Error('runner should not be called');
    },
    {
      enabled: false,
      collectionName: 'SMART-AI',
      collectionPath: '/tmp/SMART-AI',
      autoAddCollection: true,
      maxResults: 5,
      maxSnippetChars: 120
    }
  );

  assert.equal(result.tool, 'qmd_search');
  assert.match(result.summary, /devre dışı/);
  assert.equal(result.citations.length, 0);
});

test('qmd_search handles non-json output gracefully', async () => {
  const runner = async (args: string[]) => {
    if (args[0] === 'collection' && args[1] === 'list') {
      return {
        stdout: 'SMART-AI',
        stderr: ''
      };
    }

    if (args[0] === 'search') {
      return {
        stdout: 'no json output',
        stderr: 'warning: empty index'
      };
    }

    return {
      stdout: '',
      stderr: ''
    };
  };

  const result = await __private__.executeQmdSearchWithRunner(
    {
      query: 'random query',
      tenantId: 'tenant-test'
    },
    runner,
    {
      enabled: true,
      collectionName: 'SMART-AI',
      collectionPath: '/tmp/SMART-AI',
      autoAddCollection: true,
      maxResults: 5,
      maxSnippetChars: 120
    }
  );

  assert.equal(result.tool, 'qmd_search');
  assert.match(result.summary, /sonuç bulunamadı/);
});

test('qmd_search uses fallback when qmd execution fails', async () => {
  const result = await __private__.executeQmdSearchWithRunner(
    {
      query: 'smart ai hafıza fallback',
      tenantId: 'tenant-test'
    },
    async () => {
      throw new Error('spawn qmd ENOENT');
    },
    {
      enabled: true,
      collectionName: 'SMART-AI',
      collectionPath: '/tmp/SMART-AI',
      autoAddCollection: true,
      maxResults: 5,
      maxSnippetChars: 120,
      fallbackSearch: async ({ reason }) => ({
        tool: 'qmd_search',
        summary: `fallback ok: ${reason}`,
        citations: ['memory://tenant-test/mem-1']
      })
    }
  );

  assert.equal(result.tool, 'qmd_search');
  assert.match(result.summary, /fallback ok/);
  assert.ok(result.citations.includes('memory://tenant-test/mem-1'));
});
