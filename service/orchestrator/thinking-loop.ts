import { planForQuery } from './planner.js';
import type { ToolName } from '../tools/types.js';
import type { Plan } from './types.js';

function scorePlan(query: string, plan: Plan): number {
  const q = query.toLowerCase();
  let score = 0;

  if ((q.includes('finans') || q.includes('stock') || q.includes('hisse')) && plan.tools.includes('financial_deep_search')) {
    score += 3;
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
  if (plan.tools.includes('web_search')) {
    score += 1;
  }

  // small penalty for too many tools
  score -= Math.max(0, plan.tools.length - 4) * 0.5;
  return score;
}

function generateCandidates(query: string): Plan[] {
  const base = planForQuery(query);

  const aggressiveTools = [
    ...new Set<ToolName>([
      ...base.tools,
      'deep_research',
      'rag_search',
      'memory_search',
      'qmd_search',
      'mevzuat_mcp_search',
      'yargi_mcp_search',
      'borsa_mcp_search',
      'wikipedia',
      'web_search'
    ])
  ].slice(0, 5);

  const aggressive: Plan = {
    ...base,
    tools: aggressiveTools,
    reasoning: `${base.reasoning} | aggressive refinement`
  };

  const conservative: Plan = {
    ...base,
    tools: base.tools.slice(0, 3),
    reasoning: `${base.reasoning} | conservative refinement`
  };

  return [base, aggressive, conservative];
}

export function chooseBestPlan(query: string): Plan {
  const candidates = generateCandidates(query);
  const sorted = [...candidates].sort((a, b) => scorePlan(query, b) - scorePlan(query, a));
  return sorted[0] ?? candidates[0];
}
