import type { ToolName, ToolResult } from '../tools/types.js';

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
};

export type Plan = {
  objective: string;
  tools: ToolName[];
  reasoning: string;
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
};
