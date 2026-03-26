import crypto from 'node:crypto';
import { config } from '../config.js';
import { readJsonFileSync, writeJsonFileAtomic } from '../persistence/json-file.js';
import { normalizeAuthScopes, type AuthScope } from './authz.js';

type UiSession = {
  sessionId: string;
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

type UiSessionStoreOptions = {
  filePath?: string;
  persistDebounceMs?: number;
};

type PersistedUiSession = Omit<UiSession, 'tokenHash'> & {
  tokenHash: string;
};

type PersistedUiSessionSnapshot = {
  version: 1;
  updatedAt: string;
  sessions: PersistedUiSession[];
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

export type UiSessionInventoryItem = {
  sessionId: string;
  tenantId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  idleExpiresAt: number;
  principalName: string;
  scopes: AuthScope[];
  userAgentBound: boolean;
  isCurrent: boolean;
};

const SNAPSHOT_VERSION = 1;
const DEFAULT_PERSIST_DEBOUNCE_MS = 250;

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

function sanitizeLoadedSession(value: unknown): UiSession | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const sessionId = String(candidate.sessionId ?? '').trim();
  const tokenHash = String(candidate.tokenHash ?? '').trim();
  const tenantId = String(candidate.tenantId ?? '').trim();
  const principalName = String(candidate.principalName ?? '').trim() || 'ui-session';
  const createdAt = Number(candidate.createdAt ?? 0);
  const expiresAt = Number(candidate.expiresAt ?? 0);
  const lastSeenAt = Number(candidate.lastSeenAt ?? createdAt);
  const userAgentHash = typeof candidate.userAgentHash === 'string' ? candidate.userAgentHash : null;
  const scopes = normalizeAuthScopes(Array.isArray(candidate.scopes) ? candidate.scopes.map((item) => String(item)) : []);

  if (!sessionId || !tokenHash || !tenantId) {
    return null;
  }

  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || !Number.isFinite(lastSeenAt)) {
    return null;
  }

  if (expiresAt <= 0 || createdAt <= 0 || lastSeenAt <= 0) {
    return null;
  }

  return {
    sessionId,
    tokenHash,
    tenantId,
    createdAt,
    expiresAt,
    lastSeenAt,
    userAgentHash,
    principalName,
    scopes: scopes.length > 0 ? scopes : ['tenant:admin']
  };
}

class UiSessionStore {
  private readonly sessions = new Map<string, UiSession>();
  private readonly sessionIdToTokenHash = new Map<string, string>();
  private readonly globalOrder: string[] = [];
  private readonly tenantOrder = new Map<string, string[]>();
  private persistTimer: NodeJS.Timeout | null = null;
  private persistPromise: Promise<void> = Promise.resolve();

  constructor(private readonly options: UiSessionStoreOptions = {}) {
    this.hydrateFromDisk();
    this.prune();
  }

  issue(tenantId: string, ttlSeconds: number, options: UiSessionIssueOptions = {}): UiSession & { token: string } {
    this.prune();

    const now = Date.now();
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);

    const session: UiSession = {
      sessionId: crypto.randomUUID(),
      tokenHash,
      tenantId,
      createdAt: now,
      expiresAt: now + Math.max(60, ttlSeconds) * 1000,
      lastSeenAt: now,
      userAgentHash: hashUserAgent(options.userAgent),
      principalName: String(options.principalName ?? 'ui-session').trim() || 'ui-session',
      scopes: normalizeAuthScopes(options.scopes ?? ['tenant:admin'])
    };

    this.registerSession(session);
    this.enforceTenantCap(tenantId, options.maxSessionsPerTenant);
    this.enforceGlobalCap(options.maxSessionsGlobal);
    this.schedulePersist();

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
      this.schedulePersist();
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
    return this.revokeByHash(hashToken(token));
  }

  revokeSessionId(sessionId: string, tenantId?: string): boolean {
    const tokenHash = this.sessionIdToTokenHash.get(sessionId);
    if (!tokenHash) {
      return false;
    }

    const session = this.sessions.get(tokenHash);
    if (!session) {
      return false;
    }

    if (tenantId && session.tenantId !== tenantId) {
      return false;
    }

    return this.revokeByHash(tokenHash);
  }

  revokeAllForTenant(tenantId: string, options: { exceptCurrentToken?: string } = {}): number {
    const snapshot = [...(this.tenantOrder.get(tenantId) ?? [])];
    const currentHash = options.exceptCurrentToken ? hashToken(options.exceptCurrentToken) : null;

    let revokedCount = 0;
    for (const tokenHash of snapshot) {
      if (currentHash && tokenHash === currentHash) {
        continue;
      }

      if (this.revokeByHash(tokenHash)) {
        revokedCount += 1;
      }
    }

    return revokedCount;
  }

  listTenantSessions(
    tenantId: string,
    options: { limit?: number; maxIdleSeconds?: number; currentToken?: string } = {}
  ): UiSessionInventoryItem[] {
    this.prune(options.maxIdleSeconds);

    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const currentHash = options.currentToken ? hashToken(options.currentToken) : null;
    const idleWindowMs = Math.max(60, options.maxIdleSeconds ?? 0) * 1000;

    return [...(this.tenantOrder.get(tenantId) ?? [])]
      .map((tokenHash) => this.sessions.get(tokenHash) ?? null)
      .filter((session): session is UiSession => Boolean(session))
      .sort((a, b) => {
        if (b.lastSeenAt !== a.lastSeenAt) {
          return b.lastSeenAt - a.lastSeenAt;
        }
        return b.createdAt - a.createdAt;
      })
      .slice(0, limit)
      .map((session) => ({
        sessionId: session.sessionId,
        tenantId: session.tenantId,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        lastSeenAt: session.lastSeenAt,
        idleExpiresAt: session.lastSeenAt + idleWindowMs,
        principalName: session.principalName,
        scopes: session.scopes,
        userAgentBound: Boolean(session.userAgentHash),
        isCurrent: Boolean(currentHash && session.tokenHash === currentHash)
      }));
  }

  prune(maxIdleSeconds?: number): void {
    const now = Date.now();
    let mutated = false;

    for (const [tokenHash, session] of this.sessions.entries()) {
      const isExpired = now >= session.expiresAt;
      const isIdleExpired = isPositiveNumber(maxIdleSeconds) && now - session.lastSeenAt >= maxIdleSeconds * 1000;

      if (isExpired || isIdleExpired) {
        mutated = this.revokeByHash(tokenHash) || mutated;
      }
    }

    if (mutated) {
      this.schedulePersist();
    }
  }

  async flushPersistedState(): Promise<void> {
    await this.persistNow();
  }

  private registerSession(session: UiSession): void {
    this.sessions.set(session.tokenHash, session);
    this.sessionIdToTokenHash.set(session.sessionId, session.tokenHash);
    this.globalOrder.push(session.tokenHash);

    const tenantQueue = this.tenantOrder.get(session.tenantId) ?? [];
    tenantQueue.push(session.tokenHash);
    this.tenantOrder.set(session.tenantId, tenantQueue);
  }

  private revokeByHash(tokenHash: string): boolean {
    const session = this.sessions.get(tokenHash);
    if (!session) {
      return false;
    }

    this.sessions.delete(tokenHash);
    this.sessionIdToTokenHash.delete(session.sessionId);

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

    this.schedulePersist();
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

  private hydrateFromDisk(): void {
    const snapshot = readJsonFileSync<PersistedUiSessionSnapshot>(this.options.filePath);
    if (!snapshot || !Array.isArray(snapshot.sessions)) {
      return;
    }

    const now = Date.now();
    const hydrated = snapshot.sessions
      .map((entry) => sanitizeLoadedSession(entry))
      .filter((session): session is UiSession => Boolean(session))
      .filter((session) => session.expiresAt > now)
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const session of hydrated) {
      this.registerSession(session);
    }
  }

  private buildSnapshot(): PersistedUiSessionSnapshot {
    return {
      version: SNAPSHOT_VERSION,
      updatedAt: new Date().toISOString(),
      sessions: [...this.sessions.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((session) => ({
          sessionId: session.sessionId,
          tokenHash: session.tokenHash,
          tenantId: session.tenantId,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          lastSeenAt: session.lastSeenAt,
          userAgentHash: session.userAgentHash,
          principalName: session.principalName,
          scopes: session.scopes
        }))
    };
  }

  private schedulePersist(): void {
    if (!this.options.filePath) {
      return;
    }

    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }

    const delayMs = Math.max(25, this.options.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistPromise = this.persistPromise.catch(() => undefined).then(() => this.persistSnapshot());
    }, delayMs);

    this.persistTimer.unref?.();
  }

  private async persistNow(): Promise<void> {
    if (!this.options.filePath) {
      return;
    }

    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    this.persistPromise = this.persistPromise.catch(() => undefined).then(() => this.persistSnapshot());
    await this.persistPromise;
  }

  private async persistSnapshot(): Promise<void> {
    if (!this.options.filePath) {
      return;
    }

    await writeJsonFileAtomic(this.options.filePath, this.buildSnapshot());
  }
}

export function createUiSessionStore(options: UiSessionStoreOptions = {}): UiSessionStore {
  return new UiSessionStore(options);
}

export const uiSessionStore = createUiSessionStore({
  filePath: config.storage.uiSessionStoreFile,
  persistDebounceMs: config.uiSession.persistDebounceMs
});
