import type { FastifyInstance } from 'fastify';
import { getEffectiveModelPolicy } from '../../security/model-policy.js';

export async function registerModelsRoute(app: FastifyInstance) {
  app.get('/v1/models', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send({
        error: {
          type: 'authentication_error',
          message: 'Unauthorized tenant context.'
        }
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const policy = await getEffectiveModelPolicy(tenantId);
    const models = policy.allowedModels;

    return {
      object: 'list',
      data: models.map((id) => ({
        id,
        object: 'model',
        created: now,
        owned_by: id.startsWith('openrouter/') ? 'smart-ai' : 'openrouter',
        is_default: policy.defaultModel === id
      })),
      meta: {
        tenant_id: tenantId,
        source: policy.source,
        policy_status: policy.policyStatus,
        default_model: policy.defaultModel,
        total_models: models.length
      }
    };
  });
}
