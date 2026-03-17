import { config } from '../config.js';

type AttemptState = {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
};

const WINDOW_MS = 10 * 60_000;
const GC_MS = 120_000;

class UiSessionRateLimiter {
  private readonly attempts = new Map<string, AttemptState>();

  constructor(
    private readonly maxFailures: number,
    private readonly blockSeconds: number
  ) {
    setInterval(() => this.gc(), GC_MS).unref();
  }

  check(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const state = this.attempts.get(key);
    if (!state) return { allowed: true, retryAfterSeconds: 0 };

    if (state.blockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((state.blockedUntil - now) / 1000))
      };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  recordFailure(key: string, now = Date.now()): void {
    const existing = this.attempts.get(key);
    const state =
      !existing || now - existing.firstFailureAt > WINDOW_MS
        ? { failures: 0, firstFailureAt: now, blockedUntil: 0 }
        : existing;

    state.failures += 1;

    if (state.failures >= this.maxFailures) {
      state.blockedUntil = now + this.blockSeconds * 1000;
      state.failures = 0;
      state.firstFailureAt = now;
    }

    this.attempts.set(key, state);
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }

  private gc(now = Date.now()): void {
    for (const [key, state] of this.attempts.entries()) {
      const stale = now - state.firstFailureAt > WINDOW_MS * 2;
      const blockExpired = state.blockedUntil <= now;

      if (stale && blockExpired) {
        this.attempts.delete(key);
      }
    }
  }
}

export const uiSessionRateLimiter = new UiSessionRateLimiter(
  Math.max(1, config.uiSession.maxAuthFailuresPerWindow),
  Math.max(30, config.uiSession.authBlockSeconds)
);
