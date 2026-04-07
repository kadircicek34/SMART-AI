import type { ToolName, ToolResult } from '../tools/types.js';
import type { SimplicityResult } from './verifier.js';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type RunInput = {
  model: string;
  messages: ChatMessage[];
  tenantId: string;
  openRouterApiKey?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  signal?: AbortSignal;
};

export type PlanStage = {
  id: string;
  title: string;
  tools: ToolName[];
  status: 'pending' | 'running' | 'done';
};

export type Plan = {
  objective: string;
  tools: ToolName[];
  reasoning: string;
  stages?: PlanStage[];
};

export type RunOutput = {
  text: string;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error';
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
  toolResults: ToolResult[];
  plan: Plan;
  verification: {
    evidence: {
      sufficient: boolean;
      confidence: number;
      reason: string;
      suggestedTool?: ToolName;
    };
    simplicity: SimplicityResult & {
      threshold: number;
      belowThreshold: boolean;
    };
  };
};
