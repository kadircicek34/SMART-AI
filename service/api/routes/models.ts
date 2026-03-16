import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';

export async function registerModelsRoute(app: FastifyInstance) {
  app.get('/v1/models', async () => {
    const now = Math.floor(Date.now() / 1000);
    return {
      object: 'list',
      data: [
        {
          id: config.openRouter.defaultModel,
          object: 'model',
          created: now,
          owned_by: 'openrouter'
        },
        {
          id: 'openrouter/agentic-default',
          object: 'model',
          created: now,
          owned_by: 'smart-ai'
        },
        {
          id: 'openrouter/agentic-reasoning',
          object: 'model',
          created: now,
          owned_by: 'smart-ai'
        }
      ]
    };
  });
}
