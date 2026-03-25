import crypto from 'node:crypto';
import { normalizeAuthScopes, type AuthScope } from './authz.js';

type UiSession = {
  tokenHash: string;
  tenantId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  userAgentHash: string | null;
  principalName: string;
  scopes: AuthScope[];
};

type UiSessionIssueOptions = {
  userAgent?: string;
  maxSessionsPerTenant?: number;
  maxSessionsGlobal?: number;
  principalName?: string;
  scopes?: AuthScope[];
};

type UiSessionResolveOptions = {
  touch?: boolean;
  userAgent?: string;
  maxIdleSeconds?: number;
};

type UiSessionRotateOptions = UiSessionIssueOptions & {
  userAgent?: string;
  maxIdleSeconds?: number;
};

export type UiSessionResolveReason = 'not_found' | 'expired' | 'idle_timeout' | 'user_agent_mismatch';

export type UiSessionResolveResult = {
  session: UiSession | null;
  reason?: UiSessionResolveReason;
};

export type UiSessionRotateResult = {
  session: (UiSession & { token: string }) | null;
  reason?: UiSessionResolveReason;
};

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('base64url');
}

function normalizeUserAgent(userAgent: string | undefined): string {
  return String(userAgent ?? '').trim().toLowerCase();
}

function hashUserAgent(userAgent: string | undefined): string | null {
  const normalized = normalizeUserAgent(userAgent);
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('base64url');
}

function isPositiveNumber(value: number | undefined): value is number {
  return Number.isFinite(value) && (value ?? 0) > 0;
}

class UiSessionStore {
  private readonly sessions = new Map<string, UiSession>();
  private readonly globalOrder: string[] = [];
  private readonly tenantOrder = new Map<string, string[]>();

  issue(tenantId: string, ttlSeconds: number, options: UiSessionIssueOptions = {}): UiSession & { token: string } {
    this.prune();

    const now = Date.now();
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);

    const session: UiSession = {
      tokenHash,
      tenantId,
      createdAt: now,
      expiresAt: now + Math.max(60, ttlSeconds) * 1000,
      lastSeenAt: now,
      userAgentHash: hashUserAgent(options.userAgent),
      principalName: String(options.principalName ?? 'ui-session').trim() || 'ui-session',
      scopes: normalizeAuthScopes(options.scopes ?? ['tenant:admin'])
    };

    this.sessions.set(tokenHash, session);
    this.globalOrder.push(tokenHash);

    const tenantQueue = this.tenantOrder.get(tenantId) ?? [];
    tenantQueue.push(tokenHash);
    this.tenantOrder.set(tenantId, tenantQueue);

    this.enforceTenantCap(tenantId, options.maxSessionsPerTenant);
    this.enforceGlobalCap(options.maxSessionsGlobal);

    return { ...session, token };
  }

  resolve(token: string, options: UiSessionResolveOptions = {}): UiSessionResolveResult {
    const tokenHash = hashToken(token);
    const hit = this.sessions.get(tokenHash);
    if (!hit) {
      return { session: null, reason: 'not_found' };
    }

    const now = Date.now();
    if (now >= hit.expiresAt) {
      this.revokeByHash(tokenHash);
      return { session: null, reason: 'expired' };
    }

    if (isPositiveNumber(options.maxIdleSeconds) && now - hit.lastSeenAt >= options.maxIdleSeconds * 1000) {
      this.revokeByHash(tokenHash);
      return { session: null, reason: 'idle_timeout' };
    }

    if (hit.userAgentHash) {
      const candidateHash = hashUserAgent(options.userAgent);
      if (!candidateHash || candidateHash !== hit.userAgentHash) {
        this.revokeByHash(tokenHash);
        return { session: null, reason: 'user_agent_mismatch' };
      }
    }

    if (options.touch) {
      hit.lastSeenAt = now;
    }

    return { session: hit };
  }

  rotate(token: string, ttlSeconds: number, options: UiSessionRotateOptions = {}): UiSessionRotateResult {
    const resolved = this.resolve(token, {
      userAgent: options.userAgent,
      maxIdleSeconds: options.maxIdleSeconds,
      touch: false
    });

    if (!resolved.session) {
      return { session: null, reason: resolved.reason };
    }

    this.revoke(token);

    const rotated = this.issue(resolved.session.tenantId, ttlSeconds, {
      userAgent: options.userAgent,
      maxSessionsPerTenant: options.maxSessionsPerTenant,
      maxSessionsGlobal: options.maxSessionsGlobal,
      principalName: resolved.session.principalName,
      scopes: resolved.session.scopes
    });

    return { session: rotated };
  }

  revoke(token: string): boolean {
    const tokenHash = hashToken(token);
    return this.revokeByHash(tokenHash);
  }

  prune(maxIdleSeconds?: number): void {
    const now = Date.now();

    for (const [tokenHash, session] of this.sessions.entries()) {
      const isExpired = now >= session.expiresAt;
      const isIdleExpired = isPositiveNumber(maxIdleSeconds) && now - session.lastSeenAt >= maxIdleSeconds * 1000;

      if (isExpired || isIdleExpired) {
        this.revokeByHash(tokenHash);
      }
    }
  }

  private revokeByHash(tokenHash: string): boolean {
    const session = this.sessions.get(tokenHash);
    if (!session) return false;

    this.sessions.delete(tokenHash);

    const globalIndex = this.globalOrder.indexOf(tokenHash);
    if (globalIndex >= 0) {
      this.globalOrder.splice(globalIndex, 1);
    }

    const tenantQueue = this.tenantOrder.get(session.tenantId);
    if (tenantQueue) {
      const tenantIndex = tenantQueue.indexOf(tokenHash);
      if (tenantIndex >= 0) {
        tenantQueue.splice(tenantIndex, 1);
      }

      if (tenantQueue.length === 0) {
        this.tenantOrder.delete(session.tenantId);
      }
    }

    return true;
  }

  private enforceTenantCap(tenantId: string, maxSessionsPerTenant?: number): void {
    if (!isPositiveNumber(maxSessionsPerTenant)) {
      return;
    }

    const tenantQueue = this.tenantOrder.get(tenantId);
    if (!tenantQueue) {
      return;
    }

    while (tenantQueue.length > maxSessionsPerTenant) {
      const oldestTokenHash = tenantQueue.shift();
      if (oldestTokenHash) {
        this.revokeByHash(oldestTokenHash);
      }
    }
  }

  private enforceGlobalCap(maxSessionsGlobal?: number): void {
    if (!isPositiveNumber(maxSessionsGlobal)) {
      return;
    }

    while (this.globalOrder.length > maxSessionsGlobal) {
      const oldestTokenHash = this.globalOrder.shift();
      if (oldestTokenHash) {
        this.revokeByHash(oldestTokenHash);
      }
    }
  }
}

export const uiSessionStore = new UiSessionStore();
