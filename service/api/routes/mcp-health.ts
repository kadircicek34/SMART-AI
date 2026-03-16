import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getMcpHealth, resetMcpCircuit } from '../../mcp-health/index.js';
import type { McpServerId } from '../../mcp-health/types.js';

const McpServerIdSchema = z.enum(['mevzuat', 'borsa', 'yargi']);

export async function registerMcpHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/mcp/health', async (_request, reply) => {
    const health = getMcpHealth();

    return reply.status(200).send({
      status: 'ok',
      servers: health.servers,
      global: {
        totalCalls: health.globalTotalCalls,
        totalFailures: health.globalTotalFailures,
        avgLatencyMs: health.globalAvgLatencyMs
      },
      updatedAt: health.updatedAt
    });
  });

  app.post<{ Body: { serverId: McpServerId } }>('/v1/mcp/reset', async (request, reply) => {
    const parsed = McpServerIdSchema.safeParse((request.body as { serverId?: string } | undefined)?.serverId);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Invalid serverId',
        validValues: ['mevzuat', 'borsa', 'yargi']
      });
    }

    const serverId = parsed.data;
    resetMcpCircuit(serverId);

    return reply.status(200).send({
      status: 'reset',
      serverId
    });
  });

  app.get('/v1/mcp/health/:serverId', async (request, reply) => {
    const params = request.params as { serverId: string };
    const parseResult = McpServerIdSchema.safeParse(params.serverId);

    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid serverId',
        validValues: ['mevzuat', 'borsa', 'yargi']
      });
    }

    const serverId = parseResult.data;
    const health = getMcpHealth();
    const serverHealth = health.servers[serverId];

    if (!serverHealth) {
      return reply.status(404).send({
        error: 'Server not found',
        serverId
      });
    }

    return reply.status(200).send({
      status: 'ok',
      server: serverHealth
    });
  });
}
