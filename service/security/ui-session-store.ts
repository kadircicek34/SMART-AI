import crypto from 'node:crypto';

type UiSession = {
  tokenHash: string;
  tenantId: string;
  createdAt: number;
  expiresAt: number;
};

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('base64url');
}

class UiSessionStore {
  private readonly sessions = new Map<string, UiSession>();

  issue(tenantId: string, ttlSeconds: number): UiSession & { token: string } {
    this.prune();

    const now = Date.now();
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);

    const session: UiSession = {
      tokenHash,
      tenantId,
      createdAt: now,
      expiresAt: now + Math.max(60, ttlSeconds) * 1000
    };

    this.sessions.set(tokenHash, session);
    return { ...session, token };
  }

  resolve(token: string): UiSession | null {
    const tokenHash = hashToken(token);
    const hit = this.sessions.get(tokenHash);
    if (!hit) return null;

    if (Date.now() >= hit.expiresAt) {
      this.sessions.delete(tokenHash);
      return null;
    }

    return hit;
  }

  revoke(token: string): boolean {
    const tokenHash = hashToken(token);
    return this.sessions.delete(tokenHash);
  }

  prune(): void {
    const now = Date.now();
    for (const [tokenHash, session] of this.sessions.entries()) {
      if (now >= session.expiresAt) {
        this.sessions.delete(tokenHash);
      }
    }
  }
}

export const uiSessionStore = new UiSessionStore();
