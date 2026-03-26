import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { securityAuditLog } from '../../security/audit-log.js';
import { uiSessionStore } from '../../security/ui-session-store.js';

const LIST_QUERY_SCHEMA = z.object({
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 50;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 50;
    })
    .refine((value) => value >= 1 && value <= 200, { message: 'limit must be between 1 and 200' })
});

const REVOKE_ALL_BODY_SCHEMA = z.object({
  exceptCurrent: z.boolean().optional().default(false)
});

function authError() {
  return {
    error: {
      type: 'authentication_error',
      message: 'Unauthorized tenant context.'
    }
  };
}

function toSessionListResponse(sessions: ReturnType<typeof uiSessionStore.listTenantSessions>) {
  return sessions.map((session) => ({
    session_id: session.sessionId,
    tenant_id: session.tenantId,
    principal_name: session.principalName,
    scopes: session.scopes,
    created_at: new Date(session.createdAt).toISOString(),
    last_seen_at: new Date(session.lastSeenAt).toISOString(),
    expires_at: new Date(session.expiresAt).toISOString(),
    idle_expires_at: new Date(session.idleExpiresAt).toISOString(),
    user_agent_bound: session.userAgentBound,
    is_current: session.isCurrent
  }));
}

export async function registerUiSessionAdminRoutes(app: FastifyInstance) {
  app.get('/v1/ui/sessions', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = LIST_QUERY_SCHEMA.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid query for UI sessions list.',
          details: parsed.error.flatten()
        }
      });
    }

    const currentToken = req.requestContext?.authMode === 'ui_session' ? req.requestContext.authApiKey : undefined;
    const data = toSessionListResponse(
      uiSessionStore.listTenantSessions(tenantId, {
        limit: parsed.data.limit,
        maxIdleSeconds: config.uiSession.maxIdleSeconds,
        currentToken
      })
    );

    return {
      object: 'list',
      data
    };
  });

  app.post('/v1/ui/sessions/:sessionId/revoke', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const params = req.params as { sessionId?: string };
    const sessionId = String(params.sessionId ?? '').trim();
    if (!sessionId) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'sessionId is required.'
        }
      });
    }

    const revoked = uiSessionStore.revokeSessionId(sessionId, tenantId);
    securityAuditLog.record({
      tenant_id: tenantId,
      type: 'ui_session_revoked',
      ip: req.ip,
      request_id: req.requestContext?.requestId,
      details: {
        mode: 'admin_single',
        session_id: sessionId,
        revoked
      }
    });

    return reply.status(200).send({
      revoked,
      session_id: sessionId
    });
  });

  app.post('/v1/ui/sessions/revoke-all', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = REVOKE_ALL_BODY_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid revoke-all payload.',
          details: parsed.error.flatten()
        }
      });
    }

    const currentToken = parsed.data.exceptCurrent && req.requestContext?.authMode === 'ui_session'
      ? req.requestContext.authApiKey
      : undefined;

    const revokedCount = uiSessionStore.revokeAllForTenant(tenantId, {
      exceptCurrentToken: currentToken
    });

    securityAuditLog.record({
      tenant_id: tenantId,
      type: 'ui_session_revoked',
      ip: req.ip,
      request_id: req.requestContext?.requestId,
      details: {
        mode: 'admin_bulk',
        except_current: Boolean(parsed.data.exceptCurrent),
        revoked_count: revokedCount
      }
    });

    return reply.status(200).send({
      revoked_count: revokedCount,
      except_current: Boolean(parsed.data.exceptCurrent)
    });
  });
}
