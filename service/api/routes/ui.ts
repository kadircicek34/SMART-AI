import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { isAuthorizedApiKey } from '../../security/api-key-auth.js';
import { uiSessionStore } from '../../security/ui-session-store.js';
import { uiSessionRateLimiter } from '../../security/ui-session-rate-limit.js';

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

async function sendUiFile(reply: any, relativePath: string): Promise<void> {
  const filePath = path.resolve(UI_ROOT, relativePath);

  if (!isPathInside(UI_ROOT, filePath)) {
    reply.status(404).send({ error: 'Not found' });
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';

    reply.header('content-type', mime);
    reply.header('cache-control', ext === '.html' ? 'no-store' : 'public, max-age=300');
    reply.status(200).send(content);
  } catch {
    reply.status(404).send({ error: 'Not found' });
  }
}

function invalidCredentialReply(reply: any) {
  return reply.status(401).send({
    error: {
      type: 'authentication_error',
      message: 'Invalid credentials.'
    }
  });
}

export async function registerUiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ui', async (_request, reply) => {
    reply.redirect('/ui/dashboard');
  });

  app.post('/ui/session', async (request, reply) => {
    const body = (request.body ?? {}) as { apiKey?: string; tenantId?: string };
    const apiKey = String(body.apiKey ?? '').trim();
    const tenantId = String(body.tenantId ?? '').trim();

    const identityKey = `${request.ip}:${tenantId || 'unknown'}`;
    const gate = uiSessionRateLimiter.check(identityKey);
    if (!gate.allowed) {
      reply.header('retry-after', String(gate.retryAfterSeconds));
      return reply.status(429).send({
        error: {
          type: 'rate_limit_error',
          message: 'Too many authentication attempts. Please retry later.'
        }
      });
    }

    if (!apiKey || !tenantId || !isAuthorizedApiKey(apiKey)) {
      uiSessionRateLimiter.recordFailure(identityKey);
      return invalidCredentialReply(reply);
    }

    uiSessionRateLimiter.recordSuccess(identityKey);
    const session = uiSessionStore.issue(tenantId, config.uiSession.ttlSeconds);

    return reply.status(200).send({
      token: session.token,
      tenantId: session.tenantId,
      expiresAt: new Date(session.expiresAt).toISOString()
    });
  });

  app.post('/ui/session/revoke', async (request, reply) => {
    const token = extractBearer(request.headers.authorization);
    const tenantId = String(request.headers['x-tenant-id'] ?? '').trim();

    if (!token || !tenantId) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'Missing auth token or tenant header.'
        }
      });
    }

    const session = uiSessionStore.resolve(token);
    if (!session || session.tenantId !== tenantId) {
      return reply.status(200).send({ revoked: true });
    }

    uiSessionStore.revoke(token);
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
