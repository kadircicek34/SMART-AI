import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreAnswerSimplicity, verifyEvidence } from '../../orchestrator/verifier.js';

test('verifier suggests qmd_search for project-doc queries when evidence is missing', () => {
  const result = verifyEvidence(
    {
      objective: 'SMART-AI docs',
      tools: ['web_search'],
      reasoning: 'test'
    },
    [],
    'Bu projede API docs endpointleri neler?'
  );

  assert.equal(result.suggestedTool, 'qmd_search');
  assert.equal(result.sufficient, false);
});

test('verifier marks response sufficient when strong evidence exists', () => {
  const result = verifyEvidence(
    {
      objective: 'test',
      tools: ['rag_search', 'deep_research'],
      reasoning: 'test'
    },
    [
      {
        tool: 'rag_search',
        summary: 'A'.repeat(120),
        citations: ['local://doc#chk_1']
      },
      {
        tool: 'deep_research',
        summary: 'B'.repeat(130),
        citations: ['https://example.com/a', 'https://another-example.com/b']
      }
    ],
    'query'
  );

  assert.equal(result.sufficient, true);
  assert.ok(result.confidence >= 0.65);
});

test('verifier accepts qmd evidence for project-doc query', () => {
  const result = verifyEvidence(
    {
      objective: 'smart-ai project docs',
      tools: ['qmd_search', 'deep_research'],
      reasoning: 'test'
    },
    [
      {
        tool: 'qmd_search',
        summary: 'Q'.repeat(150),
        citations: ['qmd://SMART-AI/README.md', 'qmd://SMART-AI/prd.md']
      },
      {
        tool: 'deep_research',
        summary: 'R'.repeat(130),
        citations: ['https://example.com/a', 'https://another-example.com/b']
      }
    ],
    'Bu projede memory endpointleri nasıl?'
  );

  assert.equal(result.sufficient, true);
});

test('verifier keeps evidence insufficient when citations come from a single source', () => {
  const result = verifyEvidence(
    {
      objective: 'test',
      tools: ['web_search', 'wikipedia'],
      reasoning: 'test'
    },
    [
      {
        tool: 'web_search',
        summary: 'C'.repeat(140),
        citations: ['https://single-source.example/a', 'https://single-source.example/b']
      },
      {
        tool: 'wikipedia',
        summary: 'D'.repeat(130),
        citations: ['https://single-source.example/c']
      }
    ],
    'query'
  );

  assert.equal(result.sufficient, false);
  assert.equal(result.suggestedTool, 'deep_research');
});

test('verifier suggests memory_search for memory-focused queries without evidence', () => {
  const result = verifyEvidence(
    {
      objective: 'user preference query',
      tools: ['web_search'],
      reasoning: 'test'
    },
    [],
    'Benim geçen seferki tercihim neydi, hatırlıyor musun?'
  );

  assert.equal(result.sufficient, false);
  assert.equal(result.suggestedTool, 'memory_search');
});

test('verifier suggests mevzuat_mcp_search for legislation queries without evidence', () => {
  const result = verifyEvidence(
    {
      objective: 'kanun query',
      tools: ['web_search'],
      reasoning: 'test'
    },
    [],
    'İş Kanunu kapsamında kıdem tazminatı düzenlemesi nedir?'
  );

  assert.equal(result.sufficient, false);
  assert.equal(result.suggestedTool, 'mevzuat_mcp_search');
});

test('verifier suggests yargi_mcp_search for case-law queries without evidence', () => {
  const result = verifyEvidence(
    {
      objective: 'emsal query',
      tools: ['web_search'],
      reasoning: 'test'
    },
    [],
    'Yargıtay emsal kararlarıyla iş sözleşmesi feshi örnekleri neler?'
  );

  assert.equal(result.sufficient, false);
  assert.equal(result.suggestedTool, 'yargi_mcp_search');
});

test('verifier suggests borsa_mcp_search for BIST queries without evidence', () => {
  const result = verifyEvidence(
    {
      objective: 'bist query',
      tools: ['web_search'],
      reasoning: 'test'
    },
    [],
    'BIST tarafında GARAN hissesi ve XU100 için güncel durum nedir?'
  );

  assert.equal(result.sufficient, false);
  assert.equal(result.suggestedTool, 'borsa_mcp_search');
});

test('verifier suggests openbb_search for trading data queries without evidence', () => {
  const result = verifyEvidence(
    {
      objective: 'trading query',
      tools: ['web_search'],
      reasoning: 'test'
    },
    [],
    'Binance için teknik indikatör ve market data analizi yap.'
  );

  assert.equal(result.sufficient, false);
  assert.equal(result.suggestedTool, 'openbb_search');
});

test('verifier rejects mostly-failed tool outputs and asks for web_search refresh', () => {
  const result = verifyEvidence(
    {
      objective: 'generic query',
      tools: ['deep_research'],
      reasoning: 'test'
    },
    [
      {
        tool: 'deep_research',
        summary: 'failed: upstream timeout',
        citations: []
      },
      {
        tool: 'wikipedia',
        summary: 'error: no data returned',
        citations: []
      }
    ],
    'Buna dair güncel özet çıkar'
  );

  assert.equal(result.sufficient, false);
  assert.equal(result.suggestedTool, 'web_search');
});

test('simplicity scorer marks concise answer as clean', () => {
  const score = scoreAnswerSimplicity('BTC son 24 saatte dar bantta hareket etti. Hacim stabil, yön teyidi için kırılım beklenebilir.');

  assert.ok(score.score >= 0.78);
  assert.equal(score.level, 'clean');
});

test('simplicity scorer marks dense answer as dense', () => {
  const dense =
    'Bu konuya yaklaşırken bir anlamda çok katmanlı, iç içe geçmiş ve farklı paydaş beklentilerini aynı anda optimize etmeye çalışan bir perspektiften ilerlemek gerekir çünkü mimari, operasyon, veri işleme, model yönetişimi ve gözlemlenebilirlik seviyelerinin her birinde değerlendirilebilecek trade-off kümeleri vardır ve bunların her biri farklı önceliklerde, farklı zamanlarda ve farklı risk iştahlarında ele alınmalıdır. ' +
    'Genel olarak bu çerçeveyi değerlendirirken temelde sadece kısa vadeli kazanımlara bakmak yeterli değildir, aynı zamanda orta vadede bakım maliyeti, uzun vadede platform kilitlenmesi, ekip öğrenme eğrisi ve domain bağımlılığı gibi etkiler de birlikte düşünülmelidir. ' +
    'Ayrıca detaylı bağlantılar için https://example.com/a https://example.com/b https://example.com/c https://example.com/d https://example.com/e https://example.com/f incelenebilir ve bu bağlantıların her biri kendi içinde farklı bir değerlendirme perspektifi sunabilir.';

  const score = scoreAnswerSimplicity(dense);

  assert.ok(score.score < 0.58);
  assert.equal(score.level, 'dense');
});
