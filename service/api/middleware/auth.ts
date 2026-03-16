import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import '../request-context.js';

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return token.trim() || null;
}

function secureEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function isAuthorized(token: string): boolean {
  if (config.appApiKeys.length === 0) {
    return token.length > 0; // dev fallback: any non-empty bearer token
  }

  return config.appApiKeys.some((key) => secureEqual(key, token));
}

export async function authMiddleware(req: FastifyRequest, reply: FastifyReply) {
  if (!req.url.startsWith('/v1/')) return;

  const auth = extractBearer(req.headers.authorization);
  const tenantId = String(req.headers['x-tenant-id'] ?? '').trim();

  if (!auth || !isAuthorized(auth)) {
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

  req.requestContext = {
    tenantId,
    requestId: crypto.randomUUID(),
    authApiKey: auth
  };
}
