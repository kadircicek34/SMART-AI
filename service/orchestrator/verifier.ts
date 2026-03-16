import type { ToolName, ToolResult } from '../tools/types.js';
import type { Plan } from './types.js';

export type VerificationResult = {
  sufficient: boolean;
  confidence: number;
  reason: string;
  suggestedTool?: ToolName;
};

function hasMeaningfulSummary(results: ToolResult[]): boolean {
  return results.some((r) => r.summary && r.summary.length > 60 && !r.summary.includes('failed'));
}

export function verifyEvidence(plan: Plan, results: ToolResult[]): VerificationResult {
  const citationCount = results.reduce((acc, r) => acc + r.citations.length, 0);
  const hasSummary = hasMeaningfulSummary(results);

  let confidence = 0;
  if (hasSummary) confidence += 0.45;
  if (citationCount >= 2) confidence += 0.35;
  if (results.length >= 2) confidence += 0.2;

  if (confidence >= 0.65) {
    return {
      sufficient: true,
      confidence,
      reason: `Evidence sufficient (confidence=${confidence.toFixed(2)}).`
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
    reason: 'Evidence still low after available tools; will synthesize with caveats.'
  };
}
