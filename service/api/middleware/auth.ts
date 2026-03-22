import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import '../request-context.js';
import { config } from '../../config.js';
import { isAuthorizedApiKey } from '../../security/api-key-auth.js';
import { securityAuditLog } from '../../security/audit-log.js';
import { isValidTenantId, normalizeTenantId } from '../../security/tenant-id.js';
import { uiSessionStore } from '../../security/ui-session-store.js';

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return token.trim() || null;
}

function authErrorReply(reply: FastifyReply) {
  return reply.status(401).send({
    error: {
      type: 'authentication_error',
      message: 'Invalid or missing Bearer API key.'
    }
  });
}

function extractUserAgent(req: FastifyRequest): string | undefined {
  const value = req.headers['user-agent'];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export async function authMiddleware(req: FastifyRequest, reply: FastifyReply) {
  if (!req.url.startsWith('/v1/')) return;

  const auth = extractBearer(req.headers.authorization);
  const tenantId = normalizeTenantId(req.headers['x-tenant-id']);

  if (!auth) {
    if (tenantId && isValidTenantId(tenantId)) {
      securityAuditLog.record({
        tenant_id: tenantId,
        type: 'api_auth_failed',
        ip: req.ip,
        details: {
          path: req.url,
          reason: 'missing_bearer'
        }
      });
    }

    return authErrorReply(reply);
  }

  if (!tenantId) {
    return reply.status(400).send({
      error: {
        type: 'invalid_request_error',
        message: 'Missing x-tenant-id header.'
      }
    });
  }

  if (!isValidTenantId(tenantId)) {
    securityAuditLog.record({
      tenant_id: 'invalid-tenant',
      type: 'api_tenant_invalid',
      ip: req.ip,
      details: {
        path: req.url,
        method: req.method,
        tenant_candidate: tenantId.slice(0, 96)
      }
    });

    return reply.status(400).send({
      error: {
        type: 'invalid_request_error',
        message: 'Invalid x-tenant-id format.'
      }
    });
  }

  const isApiKey = isAuthorizedApiKey(auth);
  const sessionResolution = isApiKey
    ? null
    : uiSessionStore.resolve(auth, {
        touch: true,
        userAgent: extractUserAgent(req),
        maxIdleSeconds: config.uiSession.maxIdleSeconds
      });
  const session = sessionResolution?.session ?? null;

  if (!isApiKey && !session) {
    securityAuditLog.record({
      tenant_id: tenantId,
      type: 'api_auth_failed',
      ip: req.ip,
      details: {
        path: req.url,
        reason: sessionResolution?.reason ?? 'invalid_token'
      }
    });

    return authErrorReply(reply);
  }

  if (session && session.tenantId !== tenantId) {
    securityAuditLog.record({
      tenant_id: tenantId,
      type: 'api_tenant_mismatch',
      ip: req.ip,
      details: {
        path: req.url,
        token_tenant_id: session.tenantId
      }
    });

    return reply.status(403).send({
      error: {
        type: 'permission_error',
        message: 'Session token is not valid for this tenant.'
      }
    });
  }

  req.requestContext = {
    tenantId,
    requestId: crypto.randomUUID(),
    authApiKey: auth
  };
}
