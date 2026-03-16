import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  deleteTenantDocument,
  getTenantKnowledgeStats,
  ingestDocumentsForTenant,
  ingestUrlForTenant,
  listTenantDocuments,
  searchTenantKnowledge
} from '../../rag/service.js';

const DocumentInputSchema = z.object({
  document_id: z.string().min(1).max(128).optional(),
  title: z.string().min(1).max(200).optional(),
  content: z.string().min(1).max(200_000).optional(),
  text: z.string().min(1).max(200_000).optional(),
  source: z.string().max(500).optional()
});

const IngestRequestSchema = z
  .object({
    documents: z.array(DocumentInputSchema).min(1).max(20).optional(),
    url: z.string().url().optional(),
    title: z.string().min(1).max(200).optional(),
    chunk_size: z.number().int().min(250).max(3_000).optional(),
    chunk_overlap: z.number().int().min(0).max(800).optional()
  })
  .refine((value) => (value.documents?.length ?? 0) > 0 || Boolean(value.url), {
    message: 'Either documents[] or url must be provided.'
  });

const SearchRequestSchema = z.object({
  query: z.string().min(2).max(20_000),
  limit: z.number().int().min(1).max(20).optional(),
  min_score: z.number().min(0).max(5).optional()
});

const DocumentListQuerySchema = z.object({
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 50;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 50;
    })
});

export async function registerRagRoutes(app: FastifyInstance) {
  app.post('/v1/rag/documents', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send({
        error: {
          type: 'authentication_error',
          message: 'Unauthorized tenant context.'
        }
      });
    }

    const parsed = IngestRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid body for RAG ingest.',
          details: parsed.error.flatten()
        }
      });
    }

    try {
      const payload = parsed.data;

      if (payload.url) {
        const result = await ingestUrlForTenant({
          tenantId,
          url: payload.url,
          title: payload.title,
          chunkSize: payload.chunk_size,
          chunkOverlap: payload.chunk_overlap
        });

        const stats = await getTenantKnowledgeStats(tenantId);

        return {
          object: 'rag.ingest',
          mode: 'url',
          ...result,
          stats
        };
      }

      const docs = (payload.documents ?? []).map((doc) => ({
        documentId: doc.document_id,
        title: doc.title,
        source: doc.source,
        content: (doc.content ?? doc.text ?? '').trim()
      }));

      if (docs.some((doc) => !doc.content)) {
        return reply.status(400).send({
          error: {
            type: 'invalid_request_error',
            message: 'Each document requires content or text.'
          }
        });
      }

      const result = await ingestDocumentsForTenant({
        tenantId,
        documents: docs,
        chunkSize: payload.chunk_size,
        chunkOverlap: payload.chunk_overlap
      });

      const stats = await getTenantKnowledgeStats(tenantId);

      return {
        object: 'rag.ingest',
        mode: 'documents',
        ...result,
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

  app.post('/v1/rag/search', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send({
        error: {
          type: 'authentication_error',
          message: 'Unauthorized tenant context.'
        }
      });
    }

    const parsed = SearchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid body for RAG search.',
          details: parsed.error.flatten()
        }
      });
    }

    try {
      const hits = await searchTenantKnowledge({
        tenantId,
        query: parsed.data.query,
        limit: parsed.data.limit,
        minScore: parsed.data.min_score
      });

      return {
        object: 'list',
        data: hits.map((hit) => ({
          object: 'rag.chunk',
          document_id: hit.documentId,
          chunk_id: hit.chunkId,
          title: hit.title,
          source: hit.source,
          content: hit.content,
          score: hit.score
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

  app.get('/v1/rag/documents', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send({
        error: {
          type: 'authentication_error',
          message: 'Unauthorized tenant context.'
        }
      });
    }

    const parsed = DocumentListQuerySchema.safeParse(req.query);
    const limit = parsed.success ? parsed.data.limit : 50;

    const docs = await listTenantDocuments({ tenantId, limit });
    const stats = await getTenantKnowledgeStats(tenantId);

    return {
      object: 'list',
      data: docs.map((doc) => ({
        object: 'rag.document',
        document_id: doc.documentId,
        title: doc.title,
        source: doc.source,
        created: Math.floor(doc.createdAt / 1000),
        updated: Math.floor(doc.updatedAt / 1000),
        chunk_count: doc.chunkIds.length
      })),
      stats
    };
  });

  app.delete('/v1/rag/documents/:documentId', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send({
        error: {
          type: 'authentication_error',
          message: 'Unauthorized tenant context.'
        }
      });
    }

    const documentId = String((req.params as Record<string, string>).documentId ?? '').trim();
    if (!documentId) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'Missing documentId path parameter.'
        }
      });
    }

    const result = await deleteTenantDocument({ tenantId, documentId });
    if (!result.removed) {
      return reply.status(404).send({
        error: {
          type: 'not_found_error',
          message: 'Document not found for tenant.'
        }
      });
    }

    const stats = await getTenantKnowledgeStats(tenantId);

    return {
      object: 'rag.document.delete',
      document_id: documentId,
      deleted: true,
      stats
    };
  });
}
