import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { resolveApiKey } from '../../security/api-key-auth.js';
import { securityAuditLog } from '../../security/audit-log.js';
import { isOriginAllowed } from '../../security/origin-guard.js';
import { isValidTenantId, normalizeTenantId } from '../../security/tenant-id.js';
import { uiSessionRateLimiter } from '../../security/ui-session-rate-limit.js';
import { type UiSessionResolveReason, uiSessionStore } from '../../security/ui-session-store.js';

const UI_ROOT = path.resolve(process.cwd(), 'web');

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

function isPathInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return token.trim() || null;
}

function extractUserAgent(request: FastifyRequest): string | undefined {
  const value = request.headers['user-agent'];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function applySecurityHeaders(reply: FastifyReply, opts?: { isHtml?: boolean }): void {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-frame-options', 'DENY');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  reply.header('cross-origin-resource-policy', 'same-origin');

  if (opts?.isHtml) {
    reply.header(
      'content-security-policy',
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'"
    );
  }
}

function isUiOriginAllowed(originHeader: string | undefined): boolean {
  return isOriginAllowed(originHeader, config.ui.allowedOrigins);
}

function invalidCredentialReply(reply: FastifyReply) {
  applySecurityHeaders(reply);
  reply.header('cache-control', 'no-store');

  return reply.status(401).send({
    error: {
      type: 'authentication_error',
      message: 'Invalid credentials.'
    }
  });
}

function rejectInvalidTenant(reply: FastifyReply) {
  applySecurityHeaders(reply);
  reply.header('cache-control', 'no-store');

  return reply.status(400).send({
    error: {
      type: 'invalid_request_error',
      message: 'Invalid tenant id format.'
    }
  });
}

function rejectOrigin(reply: FastifyReply) {
  applySecurityHeaders(reply);
  reply.header('cache-control', 'no-store');

  return reply.status(403).send({
    error: {
      type: 'permission_error',
      message: 'Request origin is not allowed.'
    }
  });
}

function rejectMissingAuthMaterial(reply: FastifyReply) {
  applySecurityHeaders(reply);
  reply.header('cache-control', 'no-store');

  return reply.status(400).send({
    error: {
      type: 'invalid_request_error',
      message: 'Missing auth token or tenant header.'
    }
  });
}

function rejectSessionUnauthorized(reply: FastifyReply) {
  applySecurityHeaders(reply);
  reply.header('cache-control', 'no-store');

  return reply.status(401).send({
    error: {
      type: 'authentication_error',
      message: 'Invalid or expired session token.'
    }
  });
}

function assertUiOriginAllowed(request: FastifyRequest, reply: FastifyReply, tenantId?: string): boolean {
  const origin = request.headers.origin;

  if (isUiOriginAllowed(origin)) {
    return true;
  }

  if (tenantId && isValidTenantId(tenantId)) {
    securityAuditLog.record({
      tenant_id: tenantId,
      type: 'ui_origin_blocked',
      ip: request.ip,
      details: {
        origin: origin ?? 'missing'
      }
    });
  }

  void rejectOrigin(reply);
  return false;
}

function toSessionResponse(session: {
  sessionId?: string;
  tenantId: string;
  expiresAt: number;
  lastSeenAt: number;
  principalName?: string;
  scopes?: string[];
  token?: string;
}): {
  token?: string;
  sessionId?: string;
  tenantId: string;
  principalName?: string;
  scopes?: string[];
  expiresAt: string;
  lastSeenAt: string;
  expiresInSeconds: number;
  idleTimeoutSeconds: number;
  idleExpiresAt: string;
} {
  const now = Date.now();
  const expiresInSeconds = Math.max(0, Math.ceil((session.expiresAt - now) / 1000));
  const idleTimeoutSeconds = Math.max(60, config.uiSession.maxIdleSeconds);
  const idleExpiresAtMs = session.lastSeenAt + idleTimeoutSeconds * 1000;

  return {
    ...(session.token ? { token: session.token } : {}),
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    tenantId: session.tenantId,
    ...(session.principalName ? { principalName: session.principalName } : {}),
    ...(session.scopes ? { scopes: session.scopes } : {}),
    expiresAt: new Date(session.expiresAt).toISOString(),
    lastSeenAt: new Date(session.lastSeenAt).toISOString(),
    expiresInSeconds,
    idleTimeoutSeconds,
    idleExpiresAt: new Date(idleExpiresAtMs).toISOString()
  };
}

function mapResolveReasonToAudit(reason: UiSessionResolveReason | undefined): string {
  switch (reason) {
    case 'expired':
      return 'expired';
    case 'idle_timeout':
      return 'idle_timeout';
    case 'user_agent_mismatch':
      return 'fingerprint_mismatch';
    case 'not_found':
    default:
      return 'not_found';
  }
}

async function sendUiFile(reply: FastifyReply, relativePath: string): Promise<void> {
  const filePath = path.resolve(UI_ROOT, relativePath);

  if (!isPathInside(UI_ROOT, filePath)) {
    applySecurityHeaders(reply);
    reply.status(404).send({ error: 'Not found' });
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';

    applySecurityHeaders(reply, { isHtml: ext === '.html' });
    reply.header('content-type', mime);
    reply.header('cache-control', ext === '.html' ? 'no-store' : 'public, max-age=300');
    reply.status(200).send(content);
  } catch {
    applySecurityHeaders(reply);
    reply.status(404).send({ error: 'Not found' });
  }
}

export async function registerUiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ui', async (_request, reply) => {
    applySecurityHeaders(reply);
    reply.redirect('/ui/dashboard');
  });

  app.post('/ui/session', async (request, reply) => {
    const body = (request.body ?? {}) as { apiKey?: string; tenantId?: string };
    const apiKey = String(body.apiKey ?? '').trim();
    const tenantId = normalizeTenantId(body.tenantId);

    if (!tenantId || !isValidTenantId(tenantId)) {
      return rejectInvalidTenant(reply);
    }

    if (!assertUiOriginAllowed(request, reply, tenantId)) {
      return;
    }

    const identityKey = `${request.ip}:${tenantId}`;
    const gate = uiSessionRateLimiter.check(identityKey);
    if (!gate.allowed) {
      securityAuditLog.record({
        tenant_id: tenantId,
        type: 'ui_auth_rate_limited',
        ip: request.ip,
        details: {
          retry_after_seconds: gate.retryAfterSeconds
        }
      });

      applySecurityHeaders(reply);
      reply.header('retry-after', String(gate.retryAfterSeconds));
      reply.header('cache-control', 'no-store');

      return reply.status(429).send({
        error: {
          type: 'rate_limit_error',
          message: 'Too many authentication attempts. Please retry later.'
        }
      });
    }

    const apiKeyIdentity = apiKey ? resolveApiKey(apiKey) : null;
    if (!apiKeyIdentity) {
      uiSessionRateLimiter.recordFailure(identityKey);
      securityAuditLog.record({
        tenant_id: tenantId,
        type: 'ui_auth_failed',
        ip: request.ip,
        details: {
          reason: 'invalid_credentials'
        }
      });
      return invalidCredentialReply(reply);
    }

    uiSessionRateLimiter.recordSuccess(identityKey);
    const session = uiSessionStore.issue(tenantId, config.uiSession.ttlSeconds, {
      userAgent: extractUserAgent(request),
      maxSessionsPerTenant: config.uiSession.maxSessionsPerTenant,
      maxSessionsGlobal: config.uiSession.maxSessionsGlobal,
      principalName: apiKeyIdentity.name,
      scopes: apiKeyIdentity.scopes
    });

    securityAuditLog.record({
      tenant_id: tenantId,
      type: 'ui_session_issued',
      ip: request.ip,
      details: {
        ttl_seconds: config.uiSession.ttlSeconds,
        max_idle_seconds: config.uiSession.maxIdleSeconds,
        max_sessions_per_tenant: config.uiSession.maxSessionsPerTenant,
        principal_name: apiKeyIdentity.name,
        scopes_count: apiKeyIdentity.scopes.length
      }
    });

    applySecurityHeaders(reply);
    reply.header('cache-control', 'no-store');

    return reply.status(200).send(toSessionResponse(session));
  });

  app.get('/ui/session', async (request, reply) => {
    const token = extractBearer(request.headers.authorization);
    const tenantId = normalizeTenantId(request.headers['x-tenant-id']);

    if (!tenantId || !isValidTenantId(tenantId)) {
      return rejectInvalidTenant(reply);
    }

    if (!assertUiOriginAllowed(request, reply, tenantId)) {
      return;
    }

    if (!token) {
      return rejectMissingAuthMaterial(reply);
    }

    const resolved = uiSessionStore.resolve(token, {
      userAgent: extractUserAgent(request),
      maxIdleSeconds: config.uiSession.maxIdleSeconds,
      touch: false
    });

    if (!resolved.session) {
      securityAuditLog.record({
        tenant_id: tenantId,
        type: 'ui_session_validation_failed',
        ip: request.ip,
        details: {
          reason: mapResolveReasonToAudit(resolved.reason)
        }
      });
      return rejectSessionUnauthorized(reply);
    }

    if (resolved.session.tenantId !== tenantId) {
      applySecurityHeaders(reply);
      reply.header('cache-control', 'no-store');
      return reply.status(403).send({
        error: {
          type: 'permission_error',
          message: 'Session token is not valid for this tenant.'
        }
      });
    }

    applySecurityHeaders(reply);
    reply.header('cache-control', 'no-store');

    return reply.status(200).send(toSessionResponse(resolved.session));
  });

  app.post('/ui/session/refresh', async (request, reply) => {
    const token = extractBearer(request.headers.authorization);
    const tenantId = normalizeTenantId(request.headers['x-tenant-id']);

    if (!tenantId || !isValidTenantId(tenantId)) {
      return rejectInvalidTenant(reply);
    }

    if (!assertUiOriginAllowed(request, reply, tenantId)) {
      return;
    }

    if (!token) {
      return rejectMissingAuthMaterial(reply);
    }

    const rotated = uiSessionStore.rotate(token, config.uiSession.ttlSeconds, {
      userAgent: extractUserAgent(request),
      maxIdleSeconds: config.uiSession.maxIdleSeconds,
      maxSessionsPerTenant: config.uiSession.maxSessionsPerTenant,
      maxSessionsGlobal: config.uiSession.maxSessionsGlobal
    });

    if (!rotated.session) {
      securityAuditLog.record({
        tenant_id: tenantId,
        type: 'ui_session_refresh_failed',
        ip: request.ip,
        details: {
          reason: mapResolveReasonToAudit(rotated.reason)
        }
      });
      return rejectSessionUnauthorized(reply);
    }

    if (rotated.session.tenantId !== tenantId) {
      uiSessionStore.revoke(rotated.session.token);
      applySecurityHeaders(reply);
      reply.header('cache-control', 'no-store');
      return reply.status(403).send({
        error: {
          type: 'permission_error',
          message: 'Session token is not valid for this tenant.'
        }
      });
    }

    securityAuditLog.record({
      tenant_id: tenantId,
      type: 'ui_session_rotated',
      ip: request.ip,
      details: {
        ttl_seconds: config.uiSession.ttlSeconds,
        max_idle_seconds: config.uiSession.maxIdleSeconds
      }
    });

    applySecurityHeaders(reply);
    reply.header('cache-control', 'no-store');

    return reply.status(200).send(toSessionResponse(rotated.session));
  });

  app.post('/ui/session/revoke', async (request, reply) => {
    const token = extractBearer(request.headers.authorization);
    const tenantId = normalizeTenantId(request.headers['x-tenant-id']);

    if (!tenantId || !isValidTenantId(tenantId)) {
      return rejectInvalidTenant(reply);
    }

    if (!assertUiOriginAllowed(request, reply, tenantId)) {
      return;
    }

    if (!token) {
      return rejectMissingAuthMaterial(reply);
    }

    const resolved = uiSessionStore.resolve(token, {
      userAgent: extractUserAgent(request),
      maxIdleSeconds: config.uiSession.maxIdleSeconds,
      touch: false
    });

    if (!resolved.session || resolved.session.tenantId !== tenantId) {
      applySecurityHeaders(reply);
      reply.header('cache-control', 'no-store');
      return reply.status(200).send({ revoked: true });
    }

    uiSessionStore.revoke(token);
    securityAuditLog.record({
      tenant_id: tenantId,
      type: 'ui_session_revoked',
      ip: request.ip,
      details: {
        mode: 'self'
      }
    });

    applySecurityHeaders(reply);
    reply.header('cache-control', 'no-store');
    return reply.status(200).send({ revoked: true });
  });

  app.get('/ui/dashboard', async (_request, reply) => {
    await sendUiFile(reply, 'dashboard.html');
  });

  app.get('/ui/chat', async (_request, reply) => {
    await sendUiFile(reply, 'chat.html');
  });

  app.get('/ui/assets/:assetName', async (request, reply) => {
    const params = request.params as { assetName: string };
    await sendUiFile(reply, path.join('assets', params.assetName));
  });
}
