import { config } from '../config.js';

export type LlmMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type LlmResponse = {
  text: string;
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

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function chatWithOpenRouter(params: {
  apiKey: string;
  model: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
}): Promise<LlmResponse> {
  const maxAttempts = Math.max(1, config.openRouter.maxRetries + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(`${config.openRouter.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${params.apiKey}`,
        'http-referer': 'https://smart-ai.local',
        'x-title': 'SMART-AI'
      },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        temperature: params.temperature ?? 0.3,
        max_tokens: params.maxTokens ?? 1200,
        stream: false
      }),
      signal: AbortSignal.timeout(config.requestTimeoutMs)
    });

    if (response.ok) {
      const json = (await response.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };

      const content = json.choices?.[0]?.message?.content ?? '';
      const usage = json.usage ?? {};

      return {
        text: content,
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
    await sleep(delayMs);
  }

  throw new Error('OpenRouter request failed after retries.');
}

export const __private__ = {
  parseRetryAfterMs,
  isRetryableStatus,
  calculateBackoffDelayMs
};
