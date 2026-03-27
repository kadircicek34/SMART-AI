import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { securityAuditLog } from '../../security/audit-log.js';
import { RemoteUrlFetchError } from '../../rag/remote-url.js';
import {
  deleteTenantDocument,
  getTenantKnowledgeStats,
  ingestDocumentsForTenant,
  ingestUrlForTenant,
  listTenantDocuments,
  previewUrlForTenant,
  searchTenantKnowledge
} from '../../rag/service.js';
import type { RagRemoteUrlMetadata, RagRemoteUrlPreview } from '../../rag/types.js';

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

const UrlPreviewRequestSchema = z.object({
  url: z.string().url()
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

function authError() {
  return {
    error: {
      type: 'authentication_error',
      message: 'Unauthorized tenant context.'
    }
  };
}

function toRemoteUrlPayload(value: RagRemoteUrlMetadata | RagRemoteUrlPreview) {
  return {
    normalized_url: value.normalizedUrl,
    final_url: value.finalUrl,
    redirects: value.redirects,
    status_code: value.statusCode,
    content_type: value.contentType,
    content_length_bytes: value.contentLengthBytes,
    excerpt: value.excerpt,
    excerpt_truncated: value.excerptTruncated,
    ...(Object.prototype.hasOwnProperty.call(value, 'title') ? { title: (value as RagRemoteUrlPreview).title } : {})
  };
}

function recordRemoteUrlAudit(params: {
  req: FastifyRequest;
  tenantId: string;
  type: 'rag_remote_url_previewed' | 'rag_remote_url_ingested' | 'rag_remote_url_blocked' | 'rag_remote_url_fetch_failed';
  url: string;
  details?: Record<string, string | number | boolean | null>;
}) {
  securityAuditLog.record({
    tenant_id: params.tenantId,
    type: params.type,
    ip: params.req.ip,
    request_id: params.req.requestContext?.requestId,
    details: {
      path: params.req.url,
      url: params.url,
      ...params.details
    }
  });
}

function replyWithRouteError(params: {
  reply: FastifyReply;
  error: unknown;
  tenantId?: string;
  req?: FastifyRequest;
  url?: string;
}) {
  if (params.error instanceof RemoteUrlFetchError) {
    if (params.tenantId && params.req && params.url) {
      recordRemoteUrlAudit({
        req: params.req,
        tenantId: params.tenantId,
        type: params.error.statusCode >= 500 ? 'rag_remote_url_fetch_failed' : 'rag_remote_url_blocked',
        url: params.url,
        details: {
          code: params.error.code,
          ...(params.error.details ?? {})
        }
      });
    }

    return params.reply.status(params.error.statusCode).send({
      error: {
        type: params.error.statusCode >= 500 ? 'api_error' : 'invalid_request_error',
        message: params.error.message,
        details: params.error.details
      }
    });
  }

  return params.reply.status(400).send({
    error: {
      type: 'invalid_request_error',
      message: params.error instanceof Error ? params.error.message : String(params.error)
    }
  });
}

export async function registerRagRoutes(app: FastifyInstance) {
  app.post('/v1/rag/url-preview', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = UrlPreviewRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid body for RAG URL preview.',
          details: parsed.error.flatten()
        }
      });
    }

    try {
      const preview = await previewUrlForTenant({
        tenantId,
        url: parsed.data.url
      });

      recordRemoteUrlAudit({
        req,
        tenantId,
        type: 'rag_remote_url_previewed',
        url: parsed.data.url,
        details: {
          final_url: preview.finalUrl,
          content_type: preview.contentType,
          redirects: preview.redirects.length,
          bytes: preview.contentLengthBytes
        }
      });

      return {
        object: 'rag.url_preview',
        ...toRemoteUrlPayload(preview)
      };
    } catch (error) {
      return replyWithRouteError({
        reply,
        error,
        tenantId,
        req,
        url: parsed.data.url
      });
    }
  });

  app.post('/v1/rag/documents', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
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

        recordRemoteUrlAudit({
          req,
          tenantId,
          type: 'rag_remote_url_ingested',
          url: payload.url,
          details: {
            final_url: result.remoteUrl.finalUrl,
            content_type: result.remoteUrl.contentType,
            redirects: result.remoteUrl.redirects.length,
            bytes: result.remoteUrl.contentLengthBytes,
            ingested_documents: result.ingestedDocuments,
            ingested_chunks: result.ingestedChunks
          }
        });

        return {
          object: 'rag.ingest',
          mode: 'url',
          documentIds: result.documentIds,
          ingestedDocuments: result.ingestedDocuments,
          ingestedChunks: result.ingestedChunks,
          remote_url: toRemoteUrlPayload(result.remoteUrl),
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
      return replyWithRouteError({
        reply,
        error,
        tenantId,
        req,
        url: parsed.data.url
      });
    }
  });

  app.post('/v1/rag/search', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
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
      return reply.status(401).send(authError());
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
      return reply.status(401).send(authError());
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
