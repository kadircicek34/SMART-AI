import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { getTenantOpenRouterKey } from '../../security/key-store.js';
import { enqueueResearchJob, getResearchJob } from '../../worker/jobs.js';

const CreateJobSchema = z.object({
  query: z.string().min(3),
  model: z.string().optional()
});

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

    const model = parsed.data.model ?? config.openRouter.defaultModel;
    const openRouterApiKey = (await getTenantOpenRouterKey(tenantId)) ?? config.openRouter.globalApiKey;

    const job = enqueueResearchJob({
      tenantId,
      model,
      query: parsed.data.query,
      openRouterApiKey: openRouterApiKey ?? undefined
    });

    return reply.status(202).send({
      id: job.id,
      object: 'job',
      status: job.status,
      created: Math.floor(job.createdAt / 1000)
    });
  });

  app.get('/v1/jobs/:jobId', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) return reply.status(401).send({ error: { message: 'Unauthorized' } });

    const jobId = String((req.params as Record<string, string>).jobId || '');
    const job = getResearchJob(jobId);

    if (!job || job.tenantId !== tenantId) {
      return reply.status(404).send({
        error: {
          type: 'not_found_error',
          message: 'Job not found.'
        }
      });
    }

    return {
      id: job.id,
      object: 'job',
      status: job.status,
      created: Math.floor(job.createdAt / 1000),
      updated: Math.floor(job.updatedAt / 1000),
      result: job.result,
      error: job.error
    };
  });
}
