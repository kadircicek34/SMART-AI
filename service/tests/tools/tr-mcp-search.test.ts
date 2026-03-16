import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __private__ } from '../../tools/tr-mcp-search.js';

test('parsePseudoError extracts message from inspect-like mcporter output', () => {
  const parsed = __private__.parsePseudoError(`{
  content: [
    { type: 'text', text: 'Input validation error: \"phrase\" is required' }
  ],
  isError: true
}`);

  assert.ok(parsed);
  assert.match(parsed ?? '', /Input validation error/);
});

test('mevzuat_mcp_search summarizes legislation results', async () => {
  const runner = async () => ({
    stdout: JSON.stringify({
      documents: [
        {
          mevzuat_no: '6098',
          mev_adi: 'Türk Borçlar Kanunu',
          resmi_gazete_tarihi: '04.02.2011',
          resmi_gazete_sayisi: '27836',
          url: 'mevzuat?MevzuatNo=6098&MevzuatTur=1&MevzuatTertip=5'
        }
      ],
      total_results: 1
    }),
    stderr: ''
  });

  const result = await __private__.executeMevzuatMcpSearch(
    {
      query: 'borçlar kanunu',
      tenantId: 'tenant-test'
    },
    runner
  );

  assert.equal(result.tool, 'mevzuat_mcp_search');
  assert.match(result.summary, /6098/);
  assert.ok(result.citations.some((citation) => citation.includes('mevzuat.gov.tr')));
});

test('borsa_mcp_search combines search and profile calls', async () => {
  const runner = async (args: string[]) => {
    const target = args[1] ?? '';

    if (target.endsWith('.search_symbol')) {
      return {
        stdout: JSON.stringify({
          matches: [
            {
              symbol: 'GARAN',
              name: 'TÜRKİYE GARANTİ BANKASI A.Ş.',
              exchange: 'BIST'
            }
          ]
        }),
        stderr: ''
      };
    }

    if (target.endsWith('.get_profile')) {
      return {
        stdout: JSON.stringify({
          profile: {
            symbol: 'GARAN',
            exchange: 'BIST',
            pe_ratio: 5.2,
            market_cap: 557000000000
          }
        }),
        stderr: ''
      };
    }

    throw new Error(`unexpected target: ${target}`);
  };

  const result = await __private__.executeBorsaMcpSearch(
    {
      query: 'GARAN hisse kodu ve temel oranlar',
      tenantId: 'tenant-test'
    },
    runner
  );

  assert.equal(result.tool, 'borsa_mcp_search');
  assert.match(result.summary, /GARAN/);
  assert.match(result.summary, /Profil/);
});

test('yargi_mcp_search falls back to bedesten when primary returns empty', async () => {
  const runner = async (args: string[]) => {
    const target = args[1] ?? '';

    if (target.endsWith('.search_emsal_detailed_decisions')) {
      return {
        stdout: JSON.stringify({
          decisions: [],
          total_records: 0
        }),
        stderr: ''
      };
    }

    if (target.endsWith('.search_bedesten_unified')) {
      return {
        stdout: JSON.stringify({
          decisions: [
            {
              daire: 'Yargıtay 9. Hukuk Dairesi',
              esasNo: '2026/1234',
              kararNo: '2026/5678',
              kararTarihi: '10.03.2026',
              document_url: 'https://example.org/decision/1'
            }
          ],
          total_records: 1
        }),
        stderr: ''
      };
    }

    throw new Error(`unexpected target: ${target}`);
  };

  const result = await __private__.executeYargiMcpSearch(
    {
      query: 'iş sözleşmesi tazminat emsal karar',
      tenantId: 'tenant-test'
    },
    runner
  );

  assert.equal(result.tool, 'yargi_mcp_search');
  assert.match(result.summary, /Yargıtay/);
  assert.ok(result.citations.includes('https://example.org/decision/1'));
});
