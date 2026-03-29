import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  SECURITY_AUDIT_EVENT_TYPES,
  securityAuditLog,
  verifySecurityAuditIntegrity,
  type SecurityAuditEvent,
  type SecurityAuditEventType
} from '../../security/audit-log.js';

const CHAIN_HASH_REGEX = /^[a-f0-9]{64}$/;

const LIST_QUERY_SCHEMA = z.object({
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 50;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 50;
      return parsed;
    })
    .refine((value) => value >= 1 && value <= 200, { message: 'limit must be between 1 and 200' }),
  type: z.enum(SECURITY_AUDIT_EVENT_TYPES).optional(),
  since: z.string().datetime().optional()
});

const SUMMARY_QUERY_SCHEMA = z.object({
  window_hours: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 24;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 24;
      return parsed;
    })
    .refine((value) => value >= 1 && value <= 24 * 30, { message: 'window_hours must be between 1 and 720' }),
  top_ip_limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 5;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 5;
      return parsed;
    })
    .refine((value) => value >= 1 && value <= 20, { message: 'top_ip_limit must be between 1 and 20' })
});

const EXPORT_QUERY_SCHEMA = z.object({
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 200;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 200;
      return parsed;
    })
    .refine((value) => value >= 1 && value <= 1000, { message: 'limit must be between 1 and 1000' }),
  since: z.string().datetime().optional(),
  top_ip_limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 5;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 5;
      return parsed;
    })
    .refine((value) => value >= 1 && value <= 20, { message: 'top_ip_limit must be between 1 and 20' })
});

const VERIFY_EVENT_SCHEMA: z.ZodType<SecurityAuditEvent> = z.object({
  event_id: z.string().min(1).max(96),
  tenant_id: z.string().min(1).max(128),
  type: z.enum(SECURITY_AUDIT_EVENT_TYPES),
  timestamp: z.string().datetime(),
  ip: z.string().max(72).optional(),
  request_id: z.string().max(96).optional(),
  details: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  sequence: z.number().int().positive(),
  prev_chain_hash: z.string().regex(CHAIN_HASH_REGEX).nullable(),
  chain_hash: z.string().regex(CHAIN_HASH_REGEX)
});

const VERIFY_BODY_SCHEMA = z.object({
  anchorPrevChainHash: z.string().regex(CHAIN_HASH_REGEX).nullable().optional(),
  events: z.array(VERIFY_EVENT_SCHEMA).max(1000)
});

function authError() {
  return {
    error: {
      type: 'authentication_error',
      message: 'Unauthorized tenant context.'
    }
  };
}

export async function registerSecurityEventsRoute(app: FastifyInstance) {
  app.get('/v1/security/events', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = LIST_QUERY_SCHEMA.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid query for security events list.',
          details: parsed.error.flatten()
        }
      });
    }

    const type = parsed.data.type as SecurityAuditEventType | undefined;
    const sinceTimestamp = parsed.data.since ? Date.parse(parsed.data.since) : undefined;
    const data = securityAuditLog.list(tenantId, {
      limit: parsed.data.limit,
      type,
      sinceTimestamp
    });

    return {
      object: 'list',
      data
    };
  });

  app.get('/v1/security/summary', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = SUMMARY_QUERY_SCHEMA.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid query for security summary.',
          details: parsed.error.flatten()
        }
      });
    }

    const sinceTimestamp = Date.now() - parsed.data.window_hours * 60 * 60 * 1000;
    const summary = securityAuditLog.summarize(tenantId, {
      sinceTimestamp,
      topIpLimit: parsed.data.top_ip_limit
    });

    return {
      object: 'security_summary',
      tenant_id: tenantId,
      ...summary
    };
  });

  app.get('/v1/security/export', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = EXPORT_QUERY_SCHEMA.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid query for security export.',
          details: parsed.error.flatten()
        }
      });
    }

    const exportBundle = securityAuditLog.export(tenantId, {
      sinceTimestamp: parsed.data.since ? Date.parse(parsed.data.since) : undefined,
      limit: parsed.data.limit,
      topIpLimit: parsed.data.top_ip_limit
    });

    return exportBundle;
  });

  app.post('/v1/security/export/verify', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = VERIFY_BODY_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid payload for security export verification.',
          details: parsed.error.flatten()
        }
      });
    }

    const tenantMismatch = parsed.data.events.some((event) => event.tenant_id !== tenantId);
    if (tenantMismatch) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'All exported events must belong to the authenticated tenant.'
        }
      });
    }

    const integrity = verifySecurityAuditIntegrity({
      events: parsed.data.events,
      anchorPrevChainHash: parsed.data.anchorPrevChainHash ?? null
    });

    return {
      object: 'security_audit_verification',
      tenant_id: tenantId,
      data: integrity
    };
  });
}
