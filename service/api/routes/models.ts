import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { listAllowedModels } from '../../security/model-policy.js';

export async function registerModelsRoute(app: FastifyInstance) {
  app.get('/v1/models', async () => {
    const now = Math.floor(Date.now() / 1000);
    const models = listAllowedModels();

    return {
      object: 'list',
      data: models.map((id) => ({
        id,
        object: 'model',
        created: now,
        owned_by: id.startsWith('openrouter/') ? 'smart-ai' : 'openrouter'
      }))
    };
  });
}
