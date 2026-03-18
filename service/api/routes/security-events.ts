import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { securityAuditLog, type SecurityAuditEventType } from '../../security/audit-log.js';

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
  type: z
    .enum([
      'ui_session_issued',
      'ui_session_revoked',
      'ui_auth_failed',
      'ui_auth_rate_limited',
      'ui_origin_blocked',
      'api_auth_failed',
      'api_tenant_mismatch',
      'api_tenant_invalid',
      'api_rate_limited'
    ])
    .optional(),
  since: z.string().datetime().optional()
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
}
