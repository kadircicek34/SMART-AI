import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import '../request-context.js';
import { config } from '../../config.js';
import { resolveApiKey } from '../../security/api-key-auth.js';
import { hasAuthScope, resolveRequiredScope } from '../../security/authz.js';
import { securityAuditLog } from '../../security/audit-log.js';
import { isOriginAllowed } from '../../security/origin-guard.js';
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

function permissionErrorReply(reply: FastifyReply, message: string) {
  return reply.status(403).send({
    error: {
      type: 'permission_error',
      message
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

function isUnsafeMethod(method: string): boolean {
  const normalized = String(method ?? 'GET').toUpperCase();
  return normalized === 'POST' || normalized === 'PUT' || normalized === 'PATCH' || normalized === 'DELETE';
}

function isAllowedUiSessionApiOrigin(originHeader: string | undefined): boolean {
  if (config.ui.allowedOrigins.length === 0) {
    return true;
  }

  if (!originHeader) {
    return false;
  }

  return isOriginAllowed(originHeader, config.ui.allowedOrigins);
}

export async function authMiddleware(req: FastifyRequest, reply: FastifyReply) {
  if (!req.url.startsWith('/v1/')) return;

  const auth = extractBearer(req.headers.authorization);
  const tenantId = normalizeTenantId(req.headers['x-tenant-id']);
  const requestId = crypto.randomUUID();

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

  const apiKeyIdentity = resolveApiKey(auth);
  const sessionResolution = apiKeyIdentity
    ? null
    : uiSessionStore.resolve(auth, {
        touch: true,
        userAgent: extractUserAgent(req),
        maxIdleSeconds: config.uiSession.maxIdleSeconds
      });
  const session = sessionResolution?.session ?? null;

  if (!apiKeyIdentity && !session) {
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

    return permissionErrorReply(reply, 'Session token is not valid for this tenant.');
  }

  const authMode = apiKeyIdentity ? 'api_key' : 'ui_session';
  const authPrincipalName = apiKeyIdentity?.name ?? session?.principalName ?? 'ui-session';
  const authScopes = apiKeyIdentity?.scopes ?? session?.scopes ?? [];

  if (authMode === 'ui_session' && isUnsafeMethod(req.method) && !isAllowedUiSessionApiOrigin(req.headers.origin)) {
    securityAuditLog.record({
      tenant_id: tenantId,
      type: 'ui_origin_blocked',
      ip: req.ip,
      details: {
        origin: req.headers.origin ?? 'missing',
        path: req.url,
        surface: 'api'
      }
    });

    return permissionErrorReply(
      reply,
      'UI session token may only perform state-changing API requests from an allowed origin.'
    );
  }

  const requiredScope = resolveRequiredScope(req.method, req.url);
  if (!hasAuthScope(authScopes, requiredScope)) {
    securityAuditLog.record({
      tenant_id: tenantId,
      type: 'api_scope_denied',
      ip: req.ip,
      request_id: requestId,
      details: {
        path: req.url,
        method: req.method,
        auth_mode: authMode,
        principal_name: authPrincipalName,
        required_scope: requiredScope
      }
    });

    return permissionErrorReply(reply, `This credential does not have ${requiredScope} access.`);
  }

  req.requestContext = {
    tenantId,
    requestId,
    authApiKey: auth,
    authMode,
    authPrincipalName,
    authScopes,
    authRequiredScope: requiredScope
  };
}
