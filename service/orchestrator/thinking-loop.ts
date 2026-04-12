import { planForQuery, queryNeedsBroadEvidence } from './planner.js';
import type { ToolName } from '../tools/types.js';
import type { Plan } from './types.js';

function intentCoverageScore(query: string, plan: Plan): number {
  const q = query.toLowerCase();
  let score = 0;

  if ((q.includes('finans') || q.includes('stock') || q.includes('hisse')) && plan.tools.includes('financial_deep_search')) {
    score += 3;
  }
  if (
    (q.includes('openbb') || q.includes('trading') || q.includes('binance') || q.includes('teknik') || q.includes('indicator')) &&
    plan.tools.includes('openbb_search')
  ) {
    score += 3.1;
  }
  if ((q.includes('kim') || q.includes('nedir') || q.includes('history') || q.includes('what is')) && plan.tools.includes('wikipedia')) {
    score += 2;
  }
  if ((q.includes('deep') || q.includes('araştır') || q.includes('analysis') || q.includes('karşılaştır')) && plan.tools.includes('deep_research')) {
    score += 3;
  }
  if ((q.includes('doküman') || q.includes('documentation') || q.includes('repo') || q.includes('knowledge') || q.includes('rag')) && plan.tools.includes('rag_search')) {
    score += 2.5;
  }
  if ((q.includes('hatırla') || q.includes('hafıza') || q.includes('önceki') || q.includes('geçmiş') || q.includes('about me') || q.includes('my preference')) && plan.tools.includes('memory_search')) {
    score += 2.5;
  }
  if ((q.includes('repo') || q.includes('project') || q.includes('doküman') || q.includes('roadmap') || q.includes('contract')) && plan.tools.includes('qmd_search')) {
    score += 2.3;
  }
  if ((q.includes('kanun') || q.includes('mevzuat') || q.includes('tebliğ') || q.includes('resmi gazete')) && plan.tools.includes('mevzuat_mcp_search')) {
    score += 2.7;
  }
  if ((q.includes('yargıtay') || q.includes('emsal') || q.includes('mahkeme') || q.includes('yargi')) && plan.tools.includes('yargi_mcp_search')) {
    score += 2.7;
  }
  if ((q.includes('bist') || q.includes('tefas') || q.includes('kap') || q.includes('xu100')) && plan.tools.includes('borsa_mcp_search')) {
    score += 2.6;
  }

  return score;
}

function evidenceReadinessScore(query: string, plan: Plan): number {
  const broadEvidenceNeeded = queryNeedsBroadEvidence(query);
  let score = 0;
  if (plan.tools.includes('web_search')) score += broadEvidenceNeeded ? 1.1 : 0.25;
  if (plan.tools.includes('deep_research')) score += broadEvidenceNeeded ? 1.4 : 0.4;
  if (plan.tools.includes('rag_search') || plan.tools.includes('qmd_search')) score += broadEvidenceNeeded ? 1.2 : 0.8;
  if (plan.tools.includes('memory_search')) score += broadEvidenceNeeded ? 0.8 : 0.55;
  return score;
}

function clarityScore(query: string, plan: Plan): number {
  const broadEvidenceNeeded = queryNeedsBroadEvidence(query);
  const toolCount = plan.tools.length;

  if (!broadEvidenceNeeded && toolCount === 0) {
    return 1;
  }

  if (broadEvidenceNeeded && toolCount >= 2 && toolCount <= 4) {
    return 0.7;
  }

  if (!broadEvidenceNeeded && toolCount <= 2) {
    return 0.4;
  }

  return -0.6;
}

function costPenalty(query: string, plan: Plan): number {
  const broadEvidenceNeeded = queryNeedsBroadEvidence(query);
  const freeTools = broadEvidenceNeeded ? 4 : 2;
  return Math.max(0, plan.tools.length - freeTools) * (broadEvidenceNeeded ? 0.55 : 1.1);
}

function scorePlan(query: string, plan: Plan): number {
  return intentCoverageScore(query, plan) + evidenceReadinessScore(query, plan) + clarityScore(query, plan) - costPenalty(query, plan);
}

function withTools(base: Plan, tools: ToolName[], label: string): Plan {
  return {
    ...base,
    tools,
    reasoning: `${base.reasoning} | ${label}`
  };
}

function generateCandidates(query: string): Plan[] {
  const base = planForQuery(query);
  const broadEvidenceNeeded = queryNeedsBroadEvidence(query);

  if (base.tools.length === 0) {
    return [base];
  }

  if (!broadEvidenceNeeded) {
    const conservativeTools = [...new Set(base.tools)].slice(0, 2);
    return [base, withTools(base, conservativeTools, 'poetiq-direct-preserving')];
  }

  const aggressiveTools = [
    ...new Set<ToolName>([
      ...base.tools,
      'deep_research',
      'rag_search',
      'qmd_search',
      'memory_search',
      'openbb_search',
      'mevzuat_mcp_search',
      'yargi_mcp_search',
      'borsa_mcp_search',
      'web_search'
    ])
  ].slice(0, 6);

  const verifierFirstTools = [
    ...new Set<ToolName>([
      ...base.tools,
      'deep_research',
      'web_search',
      ...(base.tools.includes('qmd_search') ? ['qmd_search' as ToolName] : []),
      ...(base.tools.includes('rag_search') ? ['rag_search' as ToolName] : [])
    ])
  ].slice(0, 6);

  const conservativeTools = [...new Set(base.tools)].slice(0, 3);

  return [
    base,
    withTools(base, aggressiveTools, 'poetiq-aggressive coverage'),
    withTools(base, verifierFirstTools, 'poetiq-verifier-first'),
    withTools(base, conservativeTools, 'poetiq-conservative')
  ];
}

export function chooseBestPlan(query: string): Plan {
  const candidates = generateCandidates(query);
  const sorted = [...candidates].sort((a, b) => scorePlan(query, b) - scorePlan(query, a));
  return sorted[0] ?? candidates[0];
}
