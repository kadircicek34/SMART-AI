import { config } from '../config.js';
import { createTimeoutSignal, sleep, throwIfAborted } from '../utils/abort.js';

export type LlmMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
  reasoning?: string;
  reasoning_details?: unknown;
};

export type LlmReasoningConfig = {
  enabled?: boolean;
  exclude?: boolean;
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  max_tokens?: number;
};

export type LlmResponse = {
  text: string;
  reasoning?: string;
  reasoningDetails?: unknown;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
};

const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

function parseRetryAfterMs(rawValue: string | null): number | null {
  if (!rawValue) {
    return null;
  }

  const asSeconds = Number(rawValue);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.round(asSeconds * 1000);
  }

  const asDate = Date.parse(rawValue);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  return null;
}

function calculateBackoffDelayMs(attempt: number): number {
  const exponential = config.openRouter.retryBaseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, config.openRouter.retryMaxDelayMs);
  const jitter = Math.floor(Math.random() * 200);
  return capped + jitter;
}

function normalizeModelId(model: string): string {
  return model.trim().toLowerCase().split(':')[0] ?? model.trim().toLowerCase();
}

function supportsAutoReasoning(model: string): boolean {
  if (!config.openRouter.reasoningEnabled) {
    return false;
  }

  const normalized = normalizeModelId(model);
  return config.openRouter.reasoningModels.some((candidate) => normalizeModelId(candidate) === normalized);
}

function buildReasoningPayload(model: string, reasoning?: LlmReasoningConfig | false): LlmReasoningConfig | undefined {
  if (reasoning === false) {
    return undefined;
  }

  if (reasoning) {
    const payload: LlmReasoningConfig = {
      enabled: reasoning.enabled ?? true
    };

    if (reasoning.exclude !== undefined) {
      payload.exclude = reasoning.exclude;
    }

    if (reasoning.effort !== undefined) {
      payload.effort = reasoning.effort;
    }

    if (reasoning.max_tokens !== undefined) {
      payload.max_tokens = reasoning.max_tokens;
    }

    return payload;
  }

  if (!supportsAutoReasoning(model)) {
    return undefined;
  }

  return {
    enabled: true,
    exclude: config.openRouter.reasoningExclude
  };
}

export async function chatWithOpenRouter(params: {
  apiKey: string;
  model: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  reasoning?: LlmReasoningConfig | false;
}): Promise<LlmResponse> {
  const maxAttempts = Math.max(1, config.openRouter.maxRetries + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(params.signal);

    const payload: Record<string, unknown> = {
      model: params.model,
      messages: params.messages,
      stream: false
    };

    if (params.temperature !== undefined) {
      payload.temperature = params.temperature;
    }

    if (params.maxTokens !== undefined) {
      payload.max_tokens = params.maxTokens;
    }

    const reasoningPayload = buildReasoningPayload(params.model, params.reasoning);
    if (reasoningPayload) {
      payload.reasoning = reasoningPayload;
    }

    const response = await fetch(`${config.openRouter.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${params.apiKey}`,
        'http-referer': 'https://smart-ai.local',
        'x-title': 'SMART-AI'
      },
      body: JSON.stringify(payload),
      signal: createTimeoutSignal(config.requestTimeoutMs, params.signal)
    });

    if (response.ok) {
      const json = (await response.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string; reasoning?: string; reasoning_details?: unknown } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };

      const message = json.choices?.[0]?.message ?? {};
      const content = message.content ?? '';
      const usage = json.usage ?? {};

      return {
        text: content,
        reasoning: message.reasoning,
        reasoningDetails: message.reasoning_details,
        model: json.model ?? params.model,
        usage: {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)
        }
      };
    }

    const responseText = await response.text();
    const canRetry = attempt < maxAttempts && isRetryableStatus(response.status);
    if (!canRetry) {
      throw new Error(`OpenRouter request failed (${response.status}): ${responseText.slice(0, 500)}`);
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    const delayMs = retryAfterMs ?? calculateBackoffDelayMs(attempt);
    await sleep(delayMs, params.signal);
  }

  throw new Error('OpenRouter request failed after retries.');
}

export const __private__ = {
  parseRetryAfterMs,
  isRetryableStatus,
  calculateBackoffDelayMs,
  normalizeModelId,
  supportsAutoReasoning,
  buildReasoningPayload
};
