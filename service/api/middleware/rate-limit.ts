import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { securityAuditLog } from '../../security/audit-log.js';

type WindowState = {
  windowStartMs: number;
  count: number;
};

const store = new Map<string, WindowState>();
const WINDOW_MS = 60_000;

function getState(key: string, now: number): WindowState {
  const existing = store.get(key);
  if (!existing || now - existing.windowStartMs >= WINDOW_MS) {
    const fresh: WindowState = { windowStartMs: now, count: 0 };
    store.set(key, fresh);
    return fresh;
  }
  return existing;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store.entries()) {
    if (now - v.windowStartMs >= WINDOW_MS * 3) {
      store.delete(k);
    }
  }
}, 120_000).unref();

export async function rateLimitMiddleware(req: FastifyRequest, reply: FastifyReply) {
  if (!req.url.startsWith('/v1/')) return;

  const tenantId = req.requestContext?.tenantId;
  if (!tenantId) return;

  const now = Date.now();
  const state = getState(tenantId, now);
  state.count += 1;

  const remaining = Math.max(0, config.rateLimitPerMinute - state.count);
  reply.header('x-ratelimit-limit', String(config.rateLimitPerMinute));
  reply.header('x-ratelimit-remaining', String(remaining));
  reply.header('x-ratelimit-reset', String(state.windowStartMs + WINDOW_MS));

  if (state.count > config.rateLimitPerMinute) {
    securityAuditLog.record({
      tenant_id: tenantId,
      type: 'api_rate_limited',
      ip: req.ip,
      request_id: req.requestContext?.requestId,
      details: {
        path: req.url,
        request_count: state.count,
        window_start_ms: state.windowStartMs
      }
    });

    return reply.status(429).send({
      error: {
        type: 'rate_limit_error',
        message: 'Rate limit exceeded for this tenant.'
      }
    });
  }
}
