import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import '../request-context.js';
import { isAuthorizedApiKey } from '../../security/api-key-auth.js';
import { uiSessionStore } from '../../security/ui-session-store.js';

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return token.trim() || null;
}

export async function authMiddleware(req: FastifyRequest, reply: FastifyReply) {
  if (!req.url.startsWith('/v1/')) return;

  const auth = extractBearer(req.headers.authorization);
  const tenantId = String(req.headers['x-tenant-id'] ?? '').trim();

  if (!auth) {
    return reply.status(401).send({
      error: {
        type: 'authentication_error',
        message: 'Invalid or missing Bearer API key.'
      }
    });
  }

  const isApiKey = isAuthorizedApiKey(auth);
  const session = isApiKey ? null : uiSessionStore.resolve(auth);

  if (!isApiKey && !session) {
    return reply.status(401).send({
      error: {
        type: 'authentication_error',
        message: 'Invalid or missing Bearer API key.'
      }
    });
  }

  if (!tenantId) {
    return reply.status(400).send({
      error: {
        type: 'invalid_request_error',
        message: 'Missing x-tenant-id header.'
      }
    });
  }

  if (session && session.tenantId !== tenantId) {
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
