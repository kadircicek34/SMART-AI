import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { authMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import './request-context.js';
import { registerChatCompletionsRoute } from './routes/chat-completions.js';
import { registerJobsRoute } from './routes/jobs.js';
import { registerKeysRoute } from './routes/keys.js';
import { registerModelsRoute } from './routes/models.js';

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: 1_000_000 });

  app.get('/health', async () => ({
    ok: true,
    service: 'openrouter-agentic-intelligence-api',
    env: config.env
  }));

  app.addHook('onRequest', authMiddleware);
  app.addHook('onRequest', rateLimitMiddleware);

  void registerModelsRoute(app);
  void registerChatCompletionsRoute(app);
  void registerKeysRoute(app);
  void registerJobsRoute(app);

  return app;
}
