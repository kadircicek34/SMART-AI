import { config } from '../config.js';
import type { ToolName, ToolResult } from '../tools/types.js';
import type { Plan } from './types.js';

export type VerificationResult = {
  sufficient: boolean;
  confidence: number;
  reason: string;
  suggestedTool?: ToolName;
};

function looksFailureSummary(summary: string | undefined): boolean {
  if (!summary) return true;
  return /\b(failed?|error|timeout|denied|unavailable|no data|not found|empty result)\b/i.test(summary);
}

function hasMeaningfulSummary(results: ToolResult[]): boolean {
  return results.some((r) => r.summary && r.summary.length > 60 && !looksFailureSummary(r.summary));
}

function looksLikeKnowledgeBaseQuery(query: string | undefined): boolean {
  if (!query) return false;
  return /\b(docs?|documentation|knowledge\s?base|kb|rag|repo|codebase|api|spec|readme|dok[üu]man|iç\s?bilgi|bilgi\s?taban[ıi]|projede)\b/i.test(
    query
  );
}

function looksLikeProjectDocsQuery(query: string | undefined): boolean {
  if (!query) return false;
  return /\b(smart-ai|project docs?|repo içinde|task\.md|prd\.md|decisions\.md|delivery\.md|roadmap|state\.json|bu projede)\b/i.test(
    query
  );
}

function looksLikeMemoryQuery(query: string | undefined): boolean {
  if (!query) return false;
  return /\b(remember|recall|memory|previous|past|before|history|hatırla|hafıza|önceki|geçmiş|tercih|alışkanlık|hakkımda|profilim|benim)\b/i.test(
    query
  );
}

function looksLikeMevzuatQuery(query: string | undefined): boolean {
  if (!query) return false;
  return /(kanun|mevzuat|tebliğ|teblig|resmi gazete|cbk|khk|tüzük|yonetmelik|yönetmelik)/i.test(query);
}

function looksLikeYargiQuery(query: string | undefined): boolean {
  if (!query) return false;
  return /\b(yargıtay|yargitay|danıştay|danistay|emsal|mahkeme kararı|anayasa mahkemesi|sayıştay|kik kararı|kvkk kararı|bddk kararı)\b/i.test(
    query
  );
}

function looksLikeBorsaMcpQuery(query: string | undefined): boolean {
  if (!query) return false;
  return /\b(bist|xu100|xbank|tefas|kap haberi|hisse kodu|endeks|borsa istanbul|garan|akbnk|thyao|asels)\b/i.test(query);
}

function looksLikeOpenbbQuery(query: string | undefined): boolean {
  if (!query) return false;
  return /\b(openbb|trading|trading bot|binance|technical|teknik analiz|indikat|indicator|rsi|macd|bollinger|candlestick|ohlc|market data|company news)\b/i.test(
    query
  );
}

function citationSourceKey(citation: string): string {
  if (!citation) return 'unknown';

  try {
    const url = new URL(citation);
    return `${url.protocol}//${url.host || url.pathname}`.toLowerCase();
  } catch {
    const normalized = citation.trim().toLowerCase();
    const hashIdx = normalized.indexOf('#');
    return hashIdx >= 0 ? normalized.slice(0, hashIdx) : normalized;
  }
}

function countDistinctCitationSources(results: ToolResult[]): number {
  const sourceSet = new Set<string>();

  for (const result of results) {
    for (const citation of result.citations) {
      sourceSet.add(citationSourceKey(citation));
    }
  }

  return sourceSet.size;
}

export function verifyEvidence(plan: Plan, results: ToolResult[], query?: string): VerificationResult {
  if (results.length === 0) {
    if (looksLikeMemoryQuery(query) && !plan.tools.includes('memory_search')) {
      return {
        sufficient: false,
        confidence: 0,
        reason: 'No evidence yet. Query looks memory-focused, prioritize memory_search.',
        suggestedTool: 'memory_search'
      };
    }

    if (looksLikeOpenbbQuery(query) && !plan.tools.includes('openbb_search')) {
      return {
        sufficient: false,
        confidence: 0,
        reason: 'No evidence yet. Query looks trading/market-data focused, prioritize openbb_search.',
        suggestedTool: 'openbb_search'
      };
    }

    if (looksLikeMevzuatQuery(query) && !plan.tools.includes('mevzuat_mcp_search')) {
      return {
        sufficient: false,
        confidence: 0,
        reason: 'No evidence yet. Query looks legislation-focused, prioritize mevzuat_mcp_search.',
        suggestedTool: 'mevzuat_mcp_search'
      };
    }

    if (looksLikeYargiQuery(query) && !plan.tools.includes('yargi_mcp_search')) {
      return {
        sufficient: false,
        confidence: 0,
        reason: 'No evidence yet. Query looks case-law focused, prioritize yargi_mcp_search.',
        suggestedTool: 'yargi_mcp_search'
      };
    }

    if (looksLikeBorsaMcpQuery(query) && !plan.tools.includes('borsa_mcp_search')) {
      return {
        sufficient: false,
        confidence: 0,
        reason: 'No evidence yet. Query looks BIST/TEFAS focused, prioritize borsa_mcp_search.',
        suggestedTool: 'borsa_mcp_search'
      };
    }

    if ((looksLikeProjectDocsQuery(query) || looksLikeKnowledgeBaseQuery(query)) && !plan.tools.includes('qmd_search')) {
      return {
        sufficient: false,
        confidence: 0,
        reason: 'No evidence yet. Query looks project-doc focused, prioritize qmd_search.',
        suggestedTool: 'qmd_search'
      };
    }

    if (looksLikeKnowledgeBaseQuery(query) && !plan.tools.includes('rag_search')) {
      return {
        sufficient: false,
        confidence: 0,
        reason: 'No evidence yet. Query looks internal/knowledge-base focused, prioritize RAG search.',
        suggestedTool: 'rag_search'
      };
    }

    return {
      sufficient: false,
      confidence: 0,
      reason: 'No evidence yet. Need at least one retrieval pass.',
      suggestedTool: plan.tools.includes('deep_research') ? undefined : 'deep_research'
    };
  }

  const citationCount = results.reduce((acc, r) => acc + r.citations.length, 0);
  const distinctSources = countDistinctCitationSources(results);
  const hasSummary = hasMeaningfulSummary(results);
  const failureCount = results.filter((r) => looksFailureSummary(r.summary)).length;
  const reliabilityScore = results.length > 0 ? (results.length - failureCount) / results.length : 0;
  const hasRagEvidence = results.some((r) => r.tool === 'rag_search' && r.citations.length > 0);
  const hasMemoryEvidence = results.some((r) => r.tool === 'memory_search' && r.citations.length > 0);
  const hasQmdEvidence = results.some((r) => r.tool === 'qmd_search' && r.citations.length > 0);
  const hasOpenbbEvidence = results.some((r) => r.tool === 'openbb_search' && r.citations.length > 0);
  const hasMevzuatEvidence = results.some((r) => r.tool === 'mevzuat_mcp_search' && r.citations.length > 0);
  const hasYargiEvidence = results.some((r) => r.tool === 'yargi_mcp_search' && r.citations.length > 0);
  const hasBorsaMcpEvidence = results.some((r) => r.tool === 'borsa_mcp_search' && r.citations.length > 0);

  let confidence = 0;
  if (hasSummary) confidence += 0.35;
  confidence += reliabilityScore * 0.15;
  if (citationCount >= config.verifier.minCitations) confidence += 0.2;
  if (distinctSources >= config.verifier.minSourceDomains) confidence += 0.2;
  if (results.length >= 2) confidence += 0.15;
  if (hasRagEvidence) confidence += 0.15;
  if (hasMemoryEvidence) confidence += 0.1;
  if (hasQmdEvidence) confidence += 0.12;
  if (hasOpenbbEvidence) confidence += 0.12;
  if (hasMevzuatEvidence) confidence += 0.1;
  if (hasYargiEvidence) confidence += 0.1;
  if (hasBorsaMcpEvidence) confidence += 0.1;

  const citationFloorMet =
    citationCount >= config.verifier.minCitations ||
    hasMemoryEvidence ||
    hasQmdEvidence ||
    hasOpenbbEvidence ||
    hasMevzuatEvidence ||
    hasYargiEvidence ||
    hasBorsaMcpEvidence;
  const sourceDiversityMet = distinctSources >= config.verifier.minSourceDomains;
  const qualityFloorMet =
    citationFloorMet &&
    (sourceDiversityMet ||
      hasRagEvidence ||
      hasMemoryEvidence ||
      hasQmdEvidence ||
      hasOpenbbEvidence ||
      hasMevzuatEvidence ||
      hasYargiEvidence ||
      hasBorsaMcpEvidence);

  if (confidence >= 0.65 && qualityFloorMet && reliabilityScore >= 0.5) {
    return {
      sufficient: true,
      confidence,
      reason: `Evidence sufficient (confidence=${confidence.toFixed(2)}, citations=${citationCount}, sources=${distinctSources}).`
    };
  }

  if (looksLikeMemoryQuery(query) && !plan.tools.includes('memory_search')) {
    return {
      sufficient: false,
      confidence,
      reason: 'Confidence low for memory-focused query, adding memory_search pass.',
      suggestedTool: 'memory_search'
    };
  }

  if (looksLikeOpenbbQuery(query) && !plan.tools.includes('openbb_search')) {
    return {
      sufficient: false,
      confidence,
      reason: 'Confidence low for trading/market-data query, adding openbb_search pass.',
      suggestedTool: 'openbb_search'
    };
  }

  if (looksLikeMevzuatQuery(query) && !plan.tools.includes('mevzuat_mcp_search')) {
    return {
      sufficient: false,
      confidence,
      reason: 'Confidence low for legislation query, adding mevzuat_mcp_search pass.',
      suggestedTool: 'mevzuat_mcp_search'
    };
  }

  if (looksLikeYargiQuery(query) && !plan.tools.includes('yargi_mcp_search')) {
    return {
      sufficient: false,
      confidence,
      reason: 'Confidence low for case-law query, adding yargi_mcp_search pass.',
      suggestedTool: 'yargi_mcp_search'
    };
  }

  if (looksLikeBorsaMcpQuery(query) && !plan.tools.includes('borsa_mcp_search')) {
    return {
      sufficient: false,
      confidence,
      reason: 'Confidence low for BIST query, adding borsa_mcp_search pass.',
      suggestedTool: 'borsa_mcp_search'
    };
  }

  if ((looksLikeProjectDocsQuery(query) || looksLikeKnowledgeBaseQuery(query)) && !plan.tools.includes('qmd_search')) {
    return {
      sufficient: false,
      confidence,
      reason: 'Confidence low for project-doc query, adding qmd_search pass.',
      suggestedTool: 'qmd_search'
    };
  }

  if (looksLikeKnowledgeBaseQuery(query) && !plan.tools.includes('rag_search')) {
    return {
      sufficient: false,
      confidence,
      reason: 'Confidence low for internal query, adding rag_search pass.',
      suggestedTool: 'rag_search'
    };
  }

  if (reliabilityScore < 0.35 && !plan.tools.includes('web_search')) {
    return {
      sufficient: false,
      confidence,
      reason: `Tool outputs düşük güvenilirlikte (reliability=${reliabilityScore.toFixed(2)}), web_search ile yeni doğrulama gerekiyor.`,
      suggestedTool: 'web_search'
    };
  }

  if (!sourceDiversityMet && !plan.tools.includes('web_search') && !looksLikeMemoryQuery(query)) {
    return {
      sufficient: false,
      confidence,
      reason: `Evidence source diversity düşük (sources=${distinctSources}), web_search ile genişletiliyor.`,
      suggestedTool: 'web_search'
    };
  }

  if (!plan.tools.includes('deep_research')) {
    return {
      sufficient: false,
      confidence,
      reason: 'Evidence low, adding deep_research pass.',
      suggestedTool: 'deep_research'
    };
  }

  return {
    sufficient: false,
    confidence,
    reason: `Evidence still low after available tools (citations=${citationCount}, sources=${distinctSources}); will synthesize with caveats.`
  };
}

export const __private__ = {
  citationSourceKey,
  countDistinctCitationSources
};
