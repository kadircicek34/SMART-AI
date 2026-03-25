import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { authMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import './request-context.js';
import { registerChatCompletionsRoute } from './routes/chat-completions.js';
import { registerJobsRoute } from './routes/jobs.js';
import { registerKeysRoute } from './routes/keys.js';
import { registerModelsRoute } from './routes/models.js';
import { registerModelPolicyRoute } from './routes/model-policy.js';
import { registerRagRoutes } from './routes/rag.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerMcpHealthRoutes } from './routes/mcp-health.js';
import { registerUiRoutes } from './routes/ui.js';
import { registerSecurityEventsRoute } from './routes/security-events.js';
import { registerAuthContextRoute } from './routes/auth-context.js';

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: 1_000_000 });

  app.get('/health', async () => ({
    ok: true,
    service: 'openrouter-agentic-intelligence-api',
    env: config.env
  }));

  app.addHook('onRequest', authMiddleware);
  app.addHook('onRequest', rateLimitMiddleware);

  void registerAuthContextRoute(app);
  void registerModelsRoute(app);
  void registerModelPolicyRoute(app);
  void registerChatCompletionsRoute(app);
  void registerKeysRoute(app);
  void registerJobsRoute(app);
  void registerRagRoutes(app);
  void registerMemoryRoutes(app);
  void registerMcpHealthRoutes(app);
  void registerSecurityEventsRoute(app);
  void registerUiRoutes(app);

  return app;
}
