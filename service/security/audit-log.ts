import crypto from 'node:crypto';
import { config } from '../config.js';
import { readJsonFileSync, writeJsonFileAtomic } from '../persistence/json-file.js';

export const SECURITY_AUDIT_EVENT_TYPES = [
  'ui_session_issued',
  'ui_session_rotated',
  'ui_session_revoked',
  'ui_session_validation_failed',
  'ui_session_refresh_failed',
  'ui_auth_failed',
  'ui_auth_rate_limited',
  'ui_origin_blocked',
  'api_auth_failed',
  'api_tenant_mismatch',
  'api_tenant_invalid',
  'api_scope_denied',
  'api_rate_limited',
  'api_model_rejected',
  'model_policy_updated',
  'model_policy_reset',
  'model_policy_change_rejected',
  'research_job_queued',
  'research_job_cancelled',
  'research_job_timed_out',
  'research_job_limit_exceeded',
  'research_job_idempotency_reused',
  'research_job_rejected'
] as const;

export type SecurityAuditEventType = (typeof SECURITY_AUDIT_EVENT_TYPES)[number];

export type SecurityAuditEvent = {
  event_id: string;
  tenant_id: string;
  type: SecurityAuditEventType;
  timestamp: string;
  ip?: string;
  request_id?: string;
  details?: Record<string, string | number | boolean | null>;
};

type SecurityAuditListQuery = {
  limit?: number;
  type?: SecurityAuditEventType;
  sinceTimestamp?: number;
};

type SecurityAuditSummaryQuery = {
  sinceTimestamp?: number;
  topIpLimit?: number;
};

type SecurityAuditLogOptions = {
  filePath?: string;
  persistDebounceMs?: number;
};

type PersistedAuditSnapshot = {
  version: 1;
  updatedAt: string;
  tenants: Record<string, SecurityAuditEvent[]>;
};

export type SecurityAuditSummary = {
  windowStart: string;
  windowEnd: string;
  totalEvents: number;
  uniqueIps: number;
  byType: Record<SecurityAuditEventType, number>;
  topIps: Array<{ ip: string; count: number }>;
  alertFlags: string[];
  riskScore: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
};

const SNAPSHOT_VERSION = 1;
const DEFAULT_PERSIST_DEBOUNCE_MS = 250;
const SECURITY_AUDIT_TYPE_SET = new Set<string>(SECURITY_AUDIT_EVENT_TYPES);
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const WHITESPACE = /\s+/g;

function sanitizeString(input: string, maxLen = 220): string {
  const compact = input
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted-api-key]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted-token]')
    .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/(authorization["'\s:=]+)(Bearer\s+)?[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(CONTROL_CHARS, ' ')
    .replace(WHITESPACE, ' ')
    .trim();

  if (compact.length <= maxLen) {
    return compact;
  }

  return `${compact.slice(0, Math.max(1, maxLen - 3))}...`;
}

function sanitizeDetails(details: SecurityAuditEvent['details']): SecurityAuditEvent['details'] | undefined {
  if (!details) return undefined;

  const entries = Object.entries(details).slice(0, 30);
  if (entries.length === 0) return undefined;

  const sanitized: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of entries) {
    const normalizedKey = sanitizeString(key, 48).replace(/[^a-zA-Z0-9._-]/g, '_') || 'field';

    if (typeof value === 'string') {
      sanitized[normalizedKey] = sanitizeString(value);
      continue;
    }

    if (typeof value === 'number') {
      sanitized[normalizedKey] = Number.isFinite(value) ? value : null;
      continue;
    }

    if (typeof value === 'boolean' || value === null) {
      sanitized[normalizedKey] = value;
      continue;
    }

    sanitized[normalizedKey] = sanitizeString(JSON.stringify(value), 180);
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const sanitized = sanitizeString(ip, 72);
  return sanitized || undefined;
}

function buildTypeCountTemplate(): Record<SecurityAuditEventType, number> {
  const template = {} as Record<SecurityAuditEventType, number>;
  for (const type of SECURITY_AUDIT_EVENT_TYPES) {
    template[type] = 0;
  }
  return template;
}

function evaluateRisk(byType: Record<SecurityAuditEventType, number>): {
  score: number;
  level: SecurityAuditSummary['riskLevel'];
  flags: string[];
} {
  const authFailures = byType.ui_auth_failed + byType.api_auth_failed;

  let score = 0;
  score += authFailures;
  score += byType.ui_auth_rate_limited * 3;
  score += byType.api_rate_limited * 2;
  score += byType.api_tenant_mismatch * 5;
  score += byType.api_scope_denied * 4;
  score += byType.ui_origin_blocked * 3;
  score += byType.ui_session_validation_failed * 2;
  score += byType.ui_session_refresh_failed * 2;
  score += byType.api_model_rejected * 2;
  score += byType.model_policy_change_rejected * 2;
  score += byType.research_job_limit_exceeded * 2;
  score += byType.research_job_rejected * 2;
  score += byType.research_job_timed_out * 3;

  const flags: string[] = [];

  if (authFailures >= 8) {
    flags.push('brute_force_suspected');
  }

  if (byType.ui_auth_rate_limited >= 3 || byType.api_rate_limited >= 12) {
    flags.push('aggressive_rate_limit_violations');
  }

  if (byType.api_tenant_mismatch >= 2) {
    flags.push('cross_tenant_access_attempts');
  }

  if (byType.api_scope_denied >= 3) {
    flags.push('privilege_escalation_attempts');
  }

  if (byType.ui_origin_blocked >= 2) {
    flags.push('disallowed_origin_attempts');
  }

  if (byType.ui_session_validation_failed + byType.ui_session_refresh_failed >= 4) {
    flags.push('session_token_abuse_attempts');
  }

  if (byType.research_job_limit_exceeded >= 3) {
    flags.push('job_flooding_detected');
  }

  if (byType.research_job_rejected >= 4) {
    flags.push('malformed_job_replay_attempts');
  }

  if (byType.api_model_rejected >= 4) {
    flags.push('model_allowlist_probing');
  }

  if (byType.model_policy_change_rejected >= 3) {
    flags.push('tenant_policy_escape_attempts');
  }

  if (byType.research_job_timed_out >= 2) {
    flags.push('long_running_job_timeout_spike');
  }

  let level: SecurityAuditSummary['riskLevel'] = 'low';
  if (score >= 35) {
    level = 'critical';
  } else if (score >= 20) {
    level = 'high';
  } else if (score >= 10) {
    level = 'medium';
  }

  if (flags.includes('cross_tenant_access_attempts') && level === 'medium') {
    level = 'high';
  }

  if (flags.includes('privilege_escalation_attempts') && level === 'medium') {
    level = 'high';
  }

  return { score, level, flags };
}

function sanitizeLoadedEvent(value: unknown): SecurityAuditEvent | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const tenantId = String(candidate.tenant_id ?? '').trim();
  const type = String(candidate.type ?? '').trim();
  const timestamp = String(candidate.timestamp ?? '').trim();
  const parsedTimestamp = Date.parse(timestamp);

  if (!tenantId || !SECURITY_AUDIT_TYPE_SET.has(type) || !Number.isFinite(parsedTimestamp)) {
    return null;
  }

  const eventId = String(candidate.event_id ?? '').trim() || crypto.randomUUID();
  const requestId = String(candidate.request_id ?? '').trim();

  return {
    event_id: sanitizeString(eventId, 96),
    tenant_id: tenantId,
    type: type as SecurityAuditEventType,
    timestamp: new Date(parsedTimestamp).toISOString(),
    ip: sanitizeIp(typeof candidate.ip === 'string' ? candidate.ip : undefined),
    request_id: requestId ? sanitizeString(requestId, 96) : undefined,
    details: sanitizeDetails(
      candidate.details && typeof candidate.details === 'object'
        ? (candidate.details as Record<string, string | number | boolean | null>)
        : undefined
    )
  };
}

class SecurityAuditLog {
  private readonly eventsByTenant = new Map<string, SecurityAuditEvent[]>();
  private persistTimer: NodeJS.Timeout | null = null;
  private persistPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly maxEventsPerTenant: number,
    private readonly options: SecurityAuditLogOptions = {}
  ) {
    this.hydrateFromDisk();
  }

  record(event: Omit<SecurityAuditEvent, 'event_id' | 'timestamp'>): SecurityAuditEvent {
    const now = Date.now();

    const normalized: SecurityAuditEvent = {
      ...event,
      ip: sanitizeIp(event.ip),
      request_id: event.request_id ? sanitizeString(event.request_id, 96) : undefined,
      details: sanitizeDetails(event.details),
      event_id: crypto.randomUUID(),
      timestamp: new Date(now).toISOString()
    };

    const bucket = this.eventsByTenant.get(event.tenant_id) ?? [];
    bucket.push(normalized);

    const overflow = bucket.length - this.maxEventsPerTenant;
    if (overflow > 0) {
      bucket.splice(0, overflow);
    }

    this.eventsByTenant.set(event.tenant_id, bucket);
    this.schedulePersist();
    return normalized;
  }

  list(tenantId: string, query: SecurityAuditListQuery = {}): SecurityAuditEvent[] {
    const bucket = this.eventsByTenant.get(tenantId) ?? [];

    const filtered = bucket.filter((event) => {
      if (query.type && event.type !== query.type) return false;
      if (query.sinceTimestamp && Date.parse(event.timestamp) <= query.sinceTimestamp) return false;
      return true;
    });

    const limit = Math.max(1, Math.min(query.limit ?? 50, 200));
    return filtered.slice(-limit).reverse();
  }

  summarize(tenantId: string, query: SecurityAuditSummaryQuery = {}): SecurityAuditSummary {
    const now = Date.now();
    const sinceTimestamp = query.sinceTimestamp ?? now - 24 * 60 * 60 * 1000;

    const bucket = this.eventsByTenant.get(tenantId) ?? [];
    const filtered = bucket.filter((event) => Date.parse(event.timestamp) > sinceTimestamp);

    const byType = buildTypeCountTemplate();
    const ipCounter = new Map<string, number>();

    for (const event of filtered) {
      byType[event.type] += 1;
      if (event.ip) {
        ipCounter.set(event.ip, (ipCounter.get(event.ip) ?? 0) + 1);
      }
    }

    const topIpLimit = Math.max(1, Math.min(query.topIpLimit ?? 5, 20));
    const topIps = [...ipCounter.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })
      .slice(0, topIpLimit)
      .map(([ip, count]) => ({ ip, count }));

    const risk = evaluateRisk(byType);

    return {
      windowStart: new Date(sinceTimestamp).toISOString(),
      windowEnd: new Date(now).toISOString(),
      totalEvents: filtered.length,
      uniqueIps: ipCounter.size,
      byType,
      topIps,
      alertFlags: risk.flags,
      riskScore: risk.score,
      riskLevel: risk.level
    };
  }

  async flushPersistedState(): Promise<void> {
    await this.persistNow();
  }

  private hydrateFromDisk(): void {
    const snapshot = readJsonFileSync<PersistedAuditSnapshot>(this.options.filePath);
    if (!snapshot?.tenants || typeof snapshot.tenants !== 'object') {
      return;
    }

    for (const [tenantId, rawEvents] of Object.entries(snapshot.tenants)) {
      const events = Array.isArray(rawEvents)
        ? rawEvents.map((event) => sanitizeLoadedEvent(event)).filter((event): event is SecurityAuditEvent => Boolean(event))
        : [];

      if (events.length === 0) {
        continue;
      }

      events.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      const bounded = events.slice(-this.maxEventsPerTenant);
      this.eventsByTenant.set(tenantId, bounded);
    }
  }

  private buildSnapshot(): PersistedAuditSnapshot {
    return {
      version: SNAPSHOT_VERSION,
      updatedAt: new Date().toISOString(),
      tenants: Object.fromEntries(
        [...this.eventsByTenant.entries()].map(([tenantId, events]) => [
          tenantId,
          events.slice(-this.maxEventsPerTenant)
        ])
      )
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

export function createSecurityAuditLog(
  maxEventsPerTenant = 300,
  options: SecurityAuditLogOptions = {}
): SecurityAuditLog {
  return new SecurityAuditLog(Math.max(1, maxEventsPerTenant), options);
}

export const securityAuditLog = createSecurityAuditLog(config.security.auditMaxEventsPerTenant, {
  filePath: config.storage.securityAuditStoreFile,
  persistDebounceMs: config.security.auditPersistDebounceMs
});
