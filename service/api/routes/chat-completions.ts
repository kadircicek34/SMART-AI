import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { runOrchestrator } from '../../orchestrator/run.js';
import { getTenantOpenRouterKey } from '../../security/key-store.js';
import { autoCaptureUserMemory } from '../../memory/service.js';

const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string()
});

const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(MessageSchema).min(1),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional().default(false)
});

function chunkText(value: string, size = 180): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += size) {
    chunks.push(value.slice(i, i + size));
  }
  return chunks.length > 0 ? chunks : [''];
}

async function writeStreamChunk(reply: any, payload: object) {
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function registerChatCompletionsRoute(app: FastifyInstance) {
  app.post('/v1/chat/completions', async (req, reply) => {
    const parsed = ChatCompletionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          message: 'Invalid request body',
          type: 'invalid_request_error',
          details: parsed.error.flatten()
        }
      });
    }

    const input = parsed.data;
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send({
        error: {
          type: 'authentication_error',
          message: 'Unauthorized tenant context.'
        }
      });
    }

    const openRouterApiKey = (await getTenantOpenRouterKey(tenantId)) ?? config.openRouter.globalApiKey;

    const out = await runOrchestrator({
      tenantId,
      model: input.model,
      openRouterApiKey: openRouterApiKey ?? undefined,
      messages: input.messages,
      temperature: input.temperature,
      maxTokens: input.max_tokens,
      stream: input.stream
    });

    const latestUserMessage = [...input.messages].reverse().find((message) => message.role === 'user')?.content;
    if (latestUserMessage) {
      void autoCaptureUserMemory({
        tenantId,
        message: latestUserMessage,
        source: 'chat-completions-auto-capture'
      }).catch((error) => {
        req.log.warn({ err: error }, 'memory auto-capture failed');
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const completionId = `chatcmpl_${crypto.randomUUID().replace(/-/g, '')}`;

    if (input.stream) {
      reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
      reply.raw.setHeader('cache-control', 'no-cache, no-transform');
      reply.raw.setHeader('connection', 'keep-alive');

      const chunks = chunkText(out.text);
      for (let idx = 0; idx < chunks.length; idx++) {
        const chunk = chunks[idx];
        await writeStreamChunk(reply, {
          id: completionId,
          object: 'chat.completion.chunk',
          created: now,
          model: out.model,
          choices: [
            {
              index: 0,
              delta: idx === 0 ? { role: 'assistant', content: chunk } : { content: chunk },
              finish_reason: null
            }
          ]
        });
      }

      await writeStreamChunk(reply, {
        id: completionId,
        object: 'chat.completion.chunk',
        created: now,
        model: out.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      });
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      return reply;
    }

    return {
      id: completionId,
      object: 'chat.completion',
      created: now,
      model: out.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: out.text
          },
          finish_reason: out.finishReason
        }
      ],
      usage: {
        prompt_tokens: out.usage.promptTokens,
        completion_tokens: out.usage.completionTokens,
        total_tokens: out.usage.totalTokens
      },
      metadata: {
        tenant_id: tenantId,
        plan: out.plan,
        tool_count: out.toolResults.length
      }
    };
  });
}
