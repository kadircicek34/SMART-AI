import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { chatWithOpenRouter } from '../../llm/openrouter-client.js';
import { autoCaptureUserMemory } from '../../memory/service.js';
import { runOrchestrator } from '../../orchestrator/run.js';
import { getTenantOpenRouterKey } from '../../security/key-store.js';
import { resolveTenantModel } from '../../security/model-policy.js';
import { securityAuditLog } from '../../security/audit-log.js';

const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string()
});

const ChatCompletionRequestSchema = z.object({
  model: z.string().optional(),
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

function isStructuredDecisionMachineRequest(messages: Array<{ role: string; content: string }>): boolean {
  const merged = messages
    .map((message) => message.content || '')
    .join('\n')
    .toLowerCase();

  if (!merged) return false;

  const hasDecisionTags = merged.includes('<decision>') || merged.includes('</decision>');
  const hasStrictFormattingHint =
    merged.includes('output format (strictly follow)') ||
    merged.includes('must use xml tags <reasoning> and <decision>') ||
    merged.includes('json decision array') ||
    merged.includes('output structured json');
  const hasTradingDecisionSchemaHints =
    merged.includes('position_size_usd') &&
    (merged.includes('open_long') || merged.includes('open_short')) &&
    merged.includes('close_long');

  return hasDecisionTags && hasStrictFormattingHint && hasTradingDecisionSchemaHints;
}

function toOpenRouterMessages(messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>) {
  return messages.flatMap((message) => {
    if (message.role === 'tool') return [];
    return [{ role: message.role, content: message.content }];
  });
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

    const modelResolution = await resolveTenantModel(tenantId, input.model ?? undefined);
    if (!modelResolution.ok) {
      securityAuditLog.record({
        tenant_id: tenantId,
        type: 'api_model_rejected',
        ip: req.ip,
        request_id: req.requestContext?.requestId,
        details: {
          reason: modelResolution.auditReason,
          model: modelResolution.normalizedModel ?? (input.model?.trim() || modelResolution.policy.defaultModel || 'none'),
          policy_source: modelResolution.policy.source,
          policy_status: modelResolution.policy.policyStatus
        }
      });

      return reply.status(modelResolution.statusCode).send({
        error: {
          type: modelResolution.errorType,
          message: modelResolution.message
        }
      });
    }

    const selectedModel = modelResolution.model;
    const openRouterApiKey = (await getTenantOpenRouterKey(tenantId)) ?? config.openRouter.globalApiKey ?? undefined;

    const passthroughRequested = isStructuredDecisionMachineRequest(input.messages);
    const passthroughEnabled = passthroughRequested && Boolean(openRouterApiKey);

    if (passthroughRequested && !openRouterApiKey) {
      req.log.warn({ tenantId }, 'structured decision passthrough requested but openrouter key missing; falling back to orchestrator');
    }

    const out = passthroughEnabled
      ? await (async () => {
          const completion = await chatWithOpenRouter({
            apiKey: openRouterApiKey!,
            model: selectedModel,
            messages: toOpenRouterMessages(input.messages),
            temperature: input.temperature,
            maxTokens: input.max_tokens
          });

          return {
            text: completion.text,
            finishReason: 'stop' as const,
            model: completion.model,
            usage: {
              promptTokens: completion.usage.promptTokens,
              completionTokens: completion.usage.completionTokens,
              totalTokens: completion.usage.totalTokens
            },
            toolResults: [],
            plan: {
              objective: 'passthrough-structured-decision',
              tools: [],
              reasoning: 'Bypassed orchestrator for strict structured decision compatibility.',
              stages: [{ id: 'direct', title: 'Direct model passthrough', tools: [], status: 'done' as const }]
            },
            verification: {
              evidence: {
                sufficient: true,
                confidence: 1,
                reason: 'Passthrough mode',
                suggestedTool: undefined
              },
              simplicity: {
                score: 1,
                level: 'clean' as const,
                reasons: [],
                threshold: config.verifier.minSimplicityScore,
                belowThreshold: false
              }
            }
          };
        })()
      : await runOrchestrator({
          tenantId,
          model: selectedModel,
          openRouterApiKey,
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
        selected_model: selectedModel,
        model_policy_source: modelResolution.policy.source,
        used_default_model: modelResolution.usedDefault,
        execution_mode: passthroughEnabled ? 'passthrough_structured_decision' : 'orchestrated',
        passthrough_requested: passthroughRequested,
        plan: out.plan,
        tool_count: out.toolResults.length,
        verification: {
          evidence_sufficient: out.verification.evidence.sufficient,
          evidence_confidence: out.verification.evidence.confidence,
          evidence_reason: out.verification.evidence.reason,
          simplicity_score: out.verification.simplicity.score,
          simplicity_level: out.verification.simplicity.level,
          simplicity_threshold: out.verification.simplicity.threshold,
          simplicity_below_threshold: out.verification.simplicity.belowThreshold,
          simplicity_reasons: out.verification.simplicity.reasons
        }
      }
    };
  });
}
