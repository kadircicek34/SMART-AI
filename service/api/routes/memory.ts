import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  autoCaptureUserMemory,
  deleteTenantMemory,
  getTenantMemoryStats,
  listTenantMemories,
  memorizeForTenant,
  searchTenantMemories
} from '../../memory/service.js';
import type { MemoryCategory } from '../../memory/types.js';

const MemoryCategorySchema = z.enum([
  'profile',
  'preference',
  'habit',
  'goal',
  'todo',
  'event',
  'knowledge',
  'relationship',
  'note'
]);

const MemoryItemSchema = z.object({
  memory_id: z.string().min(1).max(128).optional(),
  content: z.string().min(1).max(10_000),
  category: MemoryCategorySchema.optional(),
  tags: z.array(z.string().min(1).max(60)).max(15).optional(),
  source: z.string().min(1).max(120).optional(),
  salience: z.number().min(0).max(1).optional(),
  context: z.string().min(1).max(4000).optional()
});

const MemorizeRequestSchema = z
  .object({
    items: z.array(MemoryItemSchema).min(1).max(30).optional(),
    content: z.string().min(1).max(10_000).optional(),
    category: MemoryCategorySchema.optional(),
    tags: z.array(z.string().min(1).max(60)).max(15).optional(),
    source: z.string().min(1).max(120).optional(),
    salience: z.number().min(0).max(1).optional(),
    context: z.string().min(1).max(4000).optional(),
    auto_capture: z
      .object({
        message: z.string().min(1).max(10_000)
      })
      .optional()
  })
  .refine((value) => (value.items?.length ?? 0) > 0 || Boolean(value.content) || Boolean(value.auto_capture), {
    message: 'Provide items[], content, or auto_capture.message.'
  });

const SearchRequestSchema = z.object({
  query: z.string().min(1).max(20_000),
  limit: z.number().int().min(1).max(25).optional(),
  min_score: z.number().min(0).max(5).optional(),
  categories: z.array(MemoryCategorySchema).max(9).optional(),
  force_retrieve: z.boolean().optional(),
  context: z.array(z.string().min(1).max(2000)).max(8).optional()
});

const ListQuerySchema = z.object({
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 50;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 50;
    }),
  category: z.string().optional()
});

function parseCategoryFilter(raw: string | undefined): MemoryCategory[] | undefined {
  if (!raw) return undefined;

  const values = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const parsed = z.array(MemoryCategorySchema).safeParse(values);
  if (!parsed.success) return undefined;
  return parsed.data;
}

function authError() {
  return {
    error: {
      type: 'authentication_error',
      message: 'Unauthorized tenant context.'
    }
  };
}

export async function registerMemoryRoutes(app: FastifyInstance) {
  app.post('/v1/memory/items', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = MemorizeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid body for memory ingest.',
          details: parsed.error.flatten()
        }
      });
    }

    const payload = parsed.data;

    try {
      if (payload.auto_capture?.message) {
        const captured = await autoCaptureUserMemory({
          tenantId,
          message: payload.auto_capture.message,
          source: payload.source ?? 'memory-api-auto-capture'
        });

        const stats = await getTenantMemoryStats(tenantId);

        return {
          object: 'memory.auto_capture',
          ...captured,
          stats
        };
      }

      const items = payload.items ?? [
        {
          content: payload.content ?? '',
          category: payload.category,
          tags: payload.tags,
          source: payload.source,
          salience: payload.salience,
          context: payload.context
        }
      ];

      const result = await memorizeForTenant({
        tenantId,
        items: items.map((item) => ({
          memoryId: item.memory_id,
          content: item.content,
          category: item.category,
          tags: item.tags,
          source: item.source,
          salience: item.salience,
          context: item.context
        }))
      });

      const stats = await getTenantMemoryStats(tenantId);

      return {
        object: 'memory.memorize',
        memory_ids: result.memoryIds,
        stored: result.stored,
        updated: result.updated,
        stats
      };
    } catch (error) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  });

  app.post('/v1/memory/search', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = SearchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid body for memory search.',
          details: parsed.error.flatten()
        }
      });
    }

    try {
      const result = await searchTenantMemories({
        tenantId,
        query: parsed.data.query,
        limit: parsed.data.limit,
        minScore: parsed.data.min_score,
        categories: parsed.data.categories,
        forceRetrieve: parsed.data.force_retrieve,
        conversationContext: parsed.data.context
      });

      return {
        object: 'list',
        decision: result.decision,
        data: result.hits.map((hit) => ({
          object: 'memory.item',
          memory_id: hit.memoryId,
          category: hit.category,
          content: hit.content,
          source: hit.source,
          tags: hit.tags,
          score: hit.score,
          created: Math.floor(hit.createdAt / 1000),
          updated: Math.floor(hit.updatedAt / 1000)
        }))
      };
    } catch (error) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  });

  app.get('/v1/memory/items', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = ListQuerySchema.safeParse(req.query);
    const limit = parsed.success ? parsed.data.limit : 50;
    const categories = parseCategoryFilter(parsed.success ? parsed.data.category : undefined);

    const items = await listTenantMemories({
      tenantId,
      limit,
      categories
    });

    const stats = await getTenantMemoryStats(tenantId);

    return {
      object: 'list',
      data: items.map((item) => ({
        object: 'memory.item',
        memory_id: item.memoryId,
        category: item.category,
        content: item.content,
        source: item.source,
        tags: item.tags,
        salience: item.salience,
        retrieval_count: item.retrievalCount,
        last_retrieved: item.lastRetrievedAt ? Math.floor(item.lastRetrievedAt / 1000) : null,
        created: Math.floor(item.createdAt / 1000),
        updated: Math.floor(item.updatedAt / 1000)
      })),
      stats
    };
  });

  app.get('/v1/memory/stats', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const stats = await getTenantMemoryStats(tenantId);

    return {
      object: 'memory.stats',
      ...stats
    };
  });

  app.delete('/v1/memory/items/:memoryId', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const memoryId = String((req.params as Record<string, string>).memoryId ?? '').trim();
    if (!memoryId) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'Missing memoryId path parameter.'
        }
      });
    }

    const result = await deleteTenantMemory({ tenantId, memoryId });
    if (!result.removed) {
      return reply.status(404).send({
        error: {
          type: 'not_found_error',
          message: 'Memory item not found for tenant.'
        }
      });
    }

    const stats = await getTenantMemoryStats(tenantId);

    return {
      object: 'memory.item.delete',
      memory_id: memoryId,
      deleted: true,
      stats
    };
  });
}
