import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { getTenantOpenRouterKey } from '../../security/key-store.js';
import { securityAuditLog } from '../../security/audit-log.js';
import {
  cancelResearchJob,
  enqueueResearchJob,
  getResearchJob,
  listResearchJobs,
  type ResearchJob
} from '../../worker/jobs.js';

const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const IDEMPOTENCY_KEY_ALLOWED = /^[A-Za-z0-9._:-]+$/;

const CreateJobSchema = z.object({
  query: z
    .string()
    .min(3)
    .max(config.research.maxQueryChars)
    .refine((value) => !CONTROL_CHARS_REGEX.test(value), { message: 'query contains invalid control characters' }),
  model: z.string().optional()
});

const ListJobsQuerySchema = z.object({
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 20;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 20;
    })
    .refine((value) => value >= 1 && value <= 100, { message: 'limit must be between 1 and 100' }),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']).optional()
});

function normalizeHeaderValue(value: unknown): string | null {
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return String(value[0] ?? '').trim() || null;
  }

  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function mapJob(job: ResearchJob) {
  return {
    id: job.id,
    object: 'job',
    status: job.status,
    model: job.model,
    created: Math.floor(job.createdAt / 1000),
    updated: Math.floor(job.updatedAt / 1000),
    result: job.result,
    error: job.error,
    cancelled_at: job.cancelledAt ? Math.floor(job.cancelledAt / 1000) : undefined
  };
}

function notFoundReply() {
  return {
    error: {
      type: 'not_found_error',
      message: 'Job not found.'
    }
  };
}

export async function registerJobsRoute(app: FastifyInstance) {
  app.post('/v1/jobs/research', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) return reply.status(401).send({ error: { message: 'Unauthorized' } });

    const parsed = CreateJobSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid body',
          details: parsed.error.flatten()
        }
      });
    }

    const idempotencyKey = normalizeHeaderValue(req.headers['idempotency-key']);
    if (idempotencyKey) {
      if (idempotencyKey.length > config.research.idempotencyKeyMaxLength || !IDEMPOTENCY_KEY_ALLOWED.test(idempotencyKey)) {
        securityAuditLog.record({
          tenant_id: tenantId,
          type: 'research_job_rejected',
          ip: req.ip,
          request_id: req.requestContext?.requestId,
          details: {
            reason: 'invalid_idempotency_key'
          }
        });

        return reply.status(400).send({
          error: {
            type: 'invalid_request_error',
            message: 'Invalid Idempotency-Key header.'
          }
        });
      }
    }

    const model = parsed.data.model ?? config.openRouter.defaultModel;
    const openRouterApiKey = (await getTenantOpenRouterKey(tenantId)) ?? config.openRouter.globalApiKey;

    const enqueueResult = enqueueResearchJob({
      tenantId,
      model,
      query: parsed.data.query,
      openRouterApiKey: openRouterApiKey ?? undefined,
      idempotencyKey: idempotencyKey ?? undefined,
      maxActiveJobsPerTenant: config.research.maxActiveJobsPerTenant
    });

    if (!enqueueResult.ok) {
      if (enqueueResult.reason === 'active_limit_exceeded') {
        securityAuditLog.record({
          tenant_id: tenantId,
          type: 'research_job_limit_exceeded',
          ip: req.ip,
          request_id: req.requestContext?.requestId,
          details: {
            active_jobs: enqueueResult.activeJobs,
            max_active_jobs: config.research.maxActiveJobsPerTenant
          }
        });

        return reply.status(429).send({
          error: {
            type: 'rate_limit_error',
            message: 'Too many active research jobs for this tenant. Please retry later.'
          }
        });
      }

      securityAuditLog.record({
        tenant_id: tenantId,
        type: 'research_job_rejected',
        ip: req.ip,
        request_id: req.requestContext?.requestId,
        details: {
          reason: 'idempotency_conflict'
        }
      });

      return reply.status(409).send({
        error: {
          type: 'invalid_request_error',
          message: 'Idempotency-Key is already used with a different request payload.'
        }
      });
    }

    if (enqueueResult.reused) {
      securityAuditLog.record({
        tenant_id: tenantId,
        type: 'research_job_idempotency_reused',
        ip: req.ip,
        request_id: req.requestContext?.requestId,
        details: {
          job_id: enqueueResult.job.id
        }
      });
    } else {
      securityAuditLog.record({
        tenant_id: tenantId,
        type: 'research_job_queued',
        ip: req.ip,
        request_id: req.requestContext?.requestId,
        details: {
          job_id: enqueueResult.job.id
        }
      });
    }

    return reply.status(enqueueResult.reused ? 200 : 202).send({
      id: enqueueResult.job.id,
      object: 'job',
      status: enqueueResult.job.status,
      created: Math.floor(enqueueResult.job.createdAt / 1000),
      updated: Math.floor(enqueueResult.job.updatedAt / 1000),
      idempotencyReused: enqueueResult.reused
    });
  });

  app.get('/v1/jobs', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) return reply.status(401).send({ error: { message: 'Unauthorized' } });

    const parsed = ListJobsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid query',
          details: parsed.error.flatten()
        }
      });
    }

    const jobs = listResearchJobs(tenantId, {
      limit: parsed.data.limit,
      status: parsed.data.status
    });

    return {
      object: 'list',
      data: jobs.map(mapJob)
    };
  });

  app.get('/v1/jobs/:jobId', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) return reply.status(401).send({ error: { message: 'Unauthorized' } });

    const jobId = String((req.params as Record<string, string>).jobId || '');
    const job = getResearchJob(jobId);

    if (!job || job.tenantId !== tenantId) {
      return reply.status(404).send(notFoundReply());
    }

    return mapJob(job);
  });

  app.post('/v1/jobs/:jobId/cancel', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) return reply.status(401).send({ error: { message: 'Unauthorized' } });

    const jobId = String((req.params as Record<string, string>).jobId || '');
    const existing = getResearchJob(jobId);
    if (!existing || existing.tenantId !== tenantId) {
      return reply.status(404).send(notFoundReply());
    }

    const wasActive = existing.status === 'queued' || existing.status === 'running';
    const previousStatus = existing.status;

    const job = cancelResearchJob(jobId, tenantId);
    if (!job) {
      return reply.status(404).send(notFoundReply());
    }

    if (wasActive && job.status === 'cancelled') {
      securityAuditLog.record({
        tenant_id: tenantId,
        type: 'research_job_cancelled',
        ip: req.ip,
        request_id: req.requestContext?.requestId,
        details: {
          job_id: job.id,
          previous_status: previousStatus
        }
      });
    }

    return {
      ...mapJob(job),
      cancelled: job.status === 'cancelled'
    };
  });
}
