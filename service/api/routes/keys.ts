import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  deleteTenantOpenRouterKey,
  hasTenantOpenRouterKey,
  setTenantOpenRouterKey,
  validateOpenRouterKeyShape
} from '../../security/key-store.js';

const UpsertKeySchema = z.object({
  apiKey: z.string().min(16)
});

export async function registerKeysRoute(app: FastifyInstance) {
  app.get('/v1/keys/openrouter/status', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) return reply.status(401).send({ error: { message: 'Unauthorized' } });

    return {
      object: 'key_status',
      tenant_id: tenantId,
      has_key: await hasTenantOpenRouterKey(tenantId)
    };
  });

  app.post('/v1/keys/openrouter', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) return reply.status(401).send({ error: { message: 'Unauthorized' } });

    const parsed = UpsertKeySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid body',
          details: parsed.error.flatten()
        }
      });
    }

    const apiKey = parsed.data.apiKey.trim();
    if (!validateOpenRouterKeyShape(apiKey)) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'OpenRouter key format is invalid.'
        }
      });
    }

    await setTenantOpenRouterKey(tenantId, apiKey);
    return {
      object: 'key_status',
      tenant_id: tenantId,
      has_key: true,
      message: 'OpenRouter key stored securely.'
    };
  });

  app.delete('/v1/keys/openrouter', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) return reply.status(401).send({ error: { message: 'Unauthorized' } });

    const removed = await deleteTenantOpenRouterKey(tenantId);
    return {
      object: 'key_status',
      tenant_id: tenantId,
      has_key: false,
      removed
    };
  });
}
