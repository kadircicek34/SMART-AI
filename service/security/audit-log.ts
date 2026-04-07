import crypto from 'node:crypto';
import { config } from '../config.js';
import { readJsonFileSync, writeJsonFileAtomic } from '../persistence/json-file.js';
import type { SecurityExportSignature } from './export-signing.js';

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
  'research_job_rejected',
  'rag_remote_url_blocked',
  'rag_remote_url_fetch_failed',
  'rag_remote_url_previewed',
  'rag_remote_url_ingested',
  'rag_remote_policy_denied',
  'rag_remote_policy_updated',
  'rag_remote_policy_reset',
  'security_export_delivered',
  'security_export_delivery_failed',
  'security_export_delivery_blocked',
  'security_export_delivery_dead_lettered',
  'security_export_delivery_redriven',
  'security_export_delivery_incident_opened',
  'security_export_delivery_incident_acknowledged',
  'security_export_delivery_incident_cleared',
  'security_export_delivery_previewed',
  'security_export_delivery_policy_updated',
  'security_export_delivery_policy_reset',
  'security_export_signing_rotated',
  'security_export_signing_policy_updated',
  'security_export_signing_maintenance_run'
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
  sequence: number;
  prev_chain_hash: string | null;
  chain_hash: string;
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

type SecurityAuditExportQuery = {
  sinceTimestamp?: number;
  limit?: number;
  topIpLimit?: number;
};

type SecurityAuditLogOptions = {
  filePath?: string;
  persistDebounceMs?: number;
};

type PersistedAuditSnapshot = {
  version: 1 | 2;
  updatedAt: string;
  tenants: Record<string, unknown[]>;
};

type LoadedAuditEvent = Omit<SecurityAuditEvent, 'sequence' | 'prev_chain_hash' | 'chain_hash'>;

export type SecurityAuditIntegrity = {
  verified: boolean;
  eventCount: number;
  anchorPrevChainHash: string | null;
  headChainHash: string | null;
  lastSequence: number | null;
  firstEventId: string | null;
  lastEventId: string | null;
  brokenAtEventId?: string;
  brokenAtSequence?: number;
  failureReason?: 'prev_hash_mismatch' | 'chain_hash_mismatch';
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
  integrity: SecurityAuditIntegrity;
};

export type SecurityAuditExportBundle = {
  object: 'security_audit_export';
  tenant_id: string;
  generated_at: string;
  filter: {
    since?: string;
    limit: number;
    truncated: boolean;
    total_matching_events: number;
  };
  summary: SecurityAuditSummary;
  integrity: SecurityAuditIntegrity;
  data: SecurityAuditEvent[];
  signature?: SecurityExportSignature;
};

const SNAPSHOT_VERSION = 2;
const DEFAULT_PERSIST_DEBOUNCE_MS = 250;
const DEFAULT_SUMMARY_WINDOW_MS = 24 * 60 * 60 * 1000;
const SECURITY_AUDIT_TYPE_SET = new Set<string>(SECURITY_AUDIT_EVENT_TYPES);
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const WHITESPACE = /\s+/g;
const CHAIN_HASH_REGEX = /^[a-f0-9]{64}$/;

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
  score += byType.rag_remote_url_blocked * 3;
  score += byType.rag_remote_url_fetch_failed * 2;
  score += byType.rag_remote_policy_denied * 3;
  score += byType.security_export_delivery_failed * 2;
  score += byType.security_export_delivery_blocked * 3;
  score += byType.security_export_delivery_dead_lettered * 4;

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

  if (byType.rag_remote_url_blocked + byType.rag_remote_policy_denied >= 3) {
    flags.push('remote_fetch_policy_violations');
  }

  if (byType.rag_remote_url_fetch_failed >= 3) {
    flags.push('remote_fetch_upstream_instability');
  }

  if (byType.security_export_delivery_blocked >= 2) {
    flags.push('security_export_egress_policy_violations');
  }

  if (byType.security_export_delivery_failed >= 2) {
    flags.push('security_export_delivery_instability');
  }

  if (byType.security_export_delivery_dead_lettered >= 1) {
    flags.push('security_export_dead_letters_present');
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

function sanitizeLoadedEvent(value: unknown): LoadedAuditEvent | null {
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

function normalizeHash(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  return CHAIN_HASH_REGEX.test(normalized) ? normalized : null;
}

function buildEventHashPayload(event: {
  event_id: string;
  tenant_id: string;
  type: SecurityAuditEventType;
  timestamp: string;
  ip?: string;
  request_id?: string;
  details?: Record<string, string | number | boolean | null>;
  sequence: number;
  prev_chain_hash: string | null;
}): string {
  return JSON.stringify({
    event_id: event.event_id,
    tenant_id: event.tenant_id,
    type: event.type,
    timestamp: event.timestamp,
    ip: event.ip ?? null,
    request_id: event.request_id ?? null,
    details: event.details ?? null,
    sequence: event.sequence,
    prev_chain_hash: event.prev_chain_hash ?? null
  });
}

function computeEventChainHash(event: {
  event_id: string;
  tenant_id: string;
  type: SecurityAuditEventType;
  timestamp: string;
  ip?: string;
  request_id?: string;
  details?: Record<string, string | number | boolean | null>;
  sequence: number;
  prev_chain_hash: string | null;
}): string {
  return crypto.createHash('sha256').update(buildEventHashPayload(event)).digest('hex');
}

function attachChain(events: LoadedAuditEvent[]): SecurityAuditEvent[] {
  const sorted = [...events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  let previousHash: string | null = null;
  return sorted.map((event, index) => {
    const sequence = index + 1;
    const next: SecurityAuditEvent = {
      ...event,
      sequence,
      prev_chain_hash: previousHash,
      chain_hash: computeEventChainHash({
        ...event,
        sequence,
        prev_chain_hash: previousHash
      })
    };

    previousHash = next.chain_hash;
    return next;
  });
}

export function verifySecurityAuditIntegrity(params: {
  events: SecurityAuditEvent[];
  anchorPrevChainHash?: string | null;
}): SecurityAuditIntegrity {
  const events = [...params.events].sort((a, b) => a.sequence - b.sequence || a.event_id.localeCompare(b.event_id));
  const anchorPrevChainHash = normalizeHash(params.anchorPrevChainHash ?? null);

  if (events.length === 0) {
    return {
      verified: true,
      eventCount: 0,
      anchorPrevChainHash,
      headChainHash: anchorPrevChainHash,
      lastSequence: null,
      firstEventId: null,
      lastEventId: null
    };
  }

  let previousHash = anchorPrevChainHash;
  for (const event of events) {
    const expectedPrevHash = normalizeHash(event.prev_chain_hash ?? null);
    if (expectedPrevHash !== previousHash) {
      return {
        verified: false,
        eventCount: events.length,
        anchorPrevChainHash,
        headChainHash: previousHash,
        lastSequence: event.sequence,
        firstEventId: events[0]?.event_id ?? null,
        lastEventId: event.event_id,
        brokenAtEventId: event.event_id,
        brokenAtSequence: event.sequence,
        failureReason: 'prev_hash_mismatch'
      };
    }

    const expectedChainHash = computeEventChainHash({
      event_id: event.event_id,
      tenant_id: event.tenant_id,
      type: event.type,
      timestamp: event.timestamp,
      ip: event.ip,
      request_id: event.request_id,
      details: event.details,
      sequence: event.sequence,
      prev_chain_hash: previousHash
    });

    if (normalizeHash(event.chain_hash) !== expectedChainHash) {
      return {
        verified: false,
        eventCount: events.length,
        anchorPrevChainHash,
        headChainHash: previousHash,
        lastSequence: event.sequence,
        firstEventId: events[0]?.event_id ?? null,
        lastEventId: event.event_id,
        brokenAtEventId: event.event_id,
        brokenAtSequence: event.sequence,
        failureReason: 'chain_hash_mismatch'
      };
    }

    previousHash = expectedChainHash;
  }

  const lastEvent = events.at(-1) ?? null;
  return {
    verified: true,
    eventCount: events.length,
    anchorPrevChainHash,
    headChainHash: previousHash,
    lastSequence: lastEvent?.sequence ?? null,
    firstEventId: events[0]?.event_id ?? null,
    lastEventId: lastEvent?.event_id ?? null
  };
}

function buildSummaryFromEvents(params: {
  events: SecurityAuditEvent[];
  sinceTimestamp: number;
  topIpLimit?: number;
  nowTimestamp?: number;
  integrity: SecurityAuditIntegrity;
}): SecurityAuditSummary {
  const now = params.nowTimestamp ?? Date.now();
  const byType = buildTypeCountTemplate();
  const ipCounter = new Map<string, number>();

  for (const event of params.events) {
    byType[event.type] += 1;
    if (event.ip) {
      ipCounter.set(event.ip, (ipCounter.get(event.ip) ?? 0) + 1);
    }
  }

  const topIpLimit = Math.max(1, Math.min(params.topIpLimit ?? 5, 20));
  const topIps = [...ipCounter.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, topIpLimit)
    .map(([ip, count]) => ({ ip, count }));

  const risk = evaluateRisk(byType);

  return {
    windowStart: new Date(params.sinceTimestamp).toISOString(),
    windowEnd: new Date(now).toISOString(),
    totalEvents: params.events.length,
    uniqueIps: ipCounter.size,
    byType,
    topIps,
    alertFlags: risk.flags,
    riskScore: risk.score,
    riskLevel: risk.level,
    integrity: params.integrity
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

  record(event: Omit<SecurityAuditEvent, 'event_id' | 'timestamp' | 'sequence' | 'prev_chain_hash' | 'chain_hash'>): SecurityAuditEvent {
    const now = Date.now();
    const bucket = this.eventsByTenant.get(event.tenant_id) ?? [];
    const previous = bucket.at(-1) ?? null;

    const normalizedBase: LoadedAuditEvent = {
      ...event,
      ip: sanitizeIp(event.ip),
      request_id: event.request_id ? sanitizeString(event.request_id, 96) : undefined,
      details: sanitizeDetails(event.details),
      event_id: crypto.randomUUID(),
      timestamp: new Date(now).toISOString()
    };

    const normalized: SecurityAuditEvent = {
      ...normalizedBase,
      sequence: previous ? previous.sequence + 1 : 1,
      prev_chain_hash: previous?.chain_hash ?? null,
      chain_hash: computeEventChainHash({
        ...normalizedBase,
        sequence: previous ? previous.sequence + 1 : 1,
        prev_chain_hash: previous?.chain_hash ?? null
      })
    };

    bucket.push(normalized);

    const overflow = bucket.length - this.maxEventsPerTenant;
    if (overflow > 0) {
      const retained = attachChain(
        bucket.slice(overflow).map((entry) => ({
          event_id: entry.event_id,
          tenant_id: entry.tenant_id,
          type: entry.type,
          timestamp: entry.timestamp,
          ip: entry.ip,
          request_id: entry.request_id,
          details: entry.details
        }))
      );
      this.eventsByTenant.set(event.tenant_id, retained);
    } else {
      this.eventsByTenant.set(event.tenant_id, bucket);
    }

    this.schedulePersist();
    return this.eventsByTenant.get(event.tenant_id)!.at(-1)!;
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
    const sinceTimestamp = query.sinceTimestamp ?? now - DEFAULT_SUMMARY_WINDOW_MS;
    const bucket = this.eventsByTenant.get(tenantId) ?? [];
    const { events, anchorPrevChainHash } = this.selectWindow(bucket, { sinceTimestamp });
    const integrity = verifySecurityAuditIntegrity({
      events,
      anchorPrevChainHash
    });

    return buildSummaryFromEvents({
      events,
      sinceTimestamp,
      topIpLimit: query.topIpLimit,
      nowTimestamp: now,
      integrity
    });
  }

  export(tenantId: string, query: SecurityAuditExportQuery = {}): SecurityAuditExportBundle {
    const now = Date.now();
    const bucket = this.eventsByTenant.get(tenantId) ?? [];
    const limit = Math.max(1, Math.min(query.limit ?? 200, 1000));
    const { events, anchorPrevChainHash, totalMatchingEvents } = this.selectWindow(bucket, {
      sinceTimestamp: query.sinceTimestamp,
      limit
    });

    const effectiveSinceTimestamp = query.sinceTimestamp ?? (events[0] ? Date.parse(events[0].timestamp) : now);
    const integrity = verifySecurityAuditIntegrity({
      events,
      anchorPrevChainHash
    });
    const summary = buildSummaryFromEvents({
      events,
      sinceTimestamp: effectiveSinceTimestamp,
      topIpLimit: query.topIpLimit,
      nowTimestamp: now,
      integrity
    });

    return {
      object: 'security_audit_export',
      tenant_id: tenantId,
      generated_at: new Date(now).toISOString(),
      filter: {
        since: query.sinceTimestamp ? new Date(query.sinceTimestamp).toISOString() : undefined,
        limit,
        truncated: totalMatchingEvents > events.length,
        total_matching_events: totalMatchingEvents
      },
      summary,
      integrity,
      data: events
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
        ? rawEvents.map((event) => sanitizeLoadedEvent(event)).filter((event): event is LoadedAuditEvent => Boolean(event))
        : [];

      if (events.length === 0) {
        continue;
      }

      const bounded = attachChain(events).slice(-this.maxEventsPerTenant);
      this.eventsByTenant.set(tenantId, bounded);
    }
  }

  private buildSnapshot(): PersistedAuditSnapshot {
    return {
      version: SNAPSHOT_VERSION,
      updatedAt: new Date().toISOString(),
      tenants: Object.fromEntries(
        [...this.eventsByTenant.entries()].map(([tenantId, events]) => [tenantId, events.slice(-this.maxEventsPerTenant)])
      )
    };
  }

  private selectWindow(
    bucket: SecurityAuditEvent[],
    query: {
      sinceTimestamp?: number;
      limit?: number;
    }
  ): {
    events: SecurityAuditEvent[];
    anchorPrevChainHash: string | null;
    totalMatchingEvents: number;
  } {
    let startIndex = 0;
    if (query.sinceTimestamp) {
      while (startIndex < bucket.length && Date.parse(bucket[startIndex]!.timestamp) <= query.sinceTimestamp) {
        startIndex += 1;
      }
    }

    const matching = bucket.slice(startIndex);
    const totalMatchingEvents = matching.length;
    const limit = query.limit ? Math.max(1, Math.min(query.limit, 1000)) : undefined;
    const events = limit && matching.length > limit ? matching.slice(-limit) : matching;
    const firstEvent = events[0];
    const firstIndex = firstEvent ? bucket.findIndex((candidate) => candidate.event_id === firstEvent.event_id) : -1;
    const anchorPrevChainHash = firstIndex > 0 ? bucket[firstIndex - 1]!.chain_hash : null;

    return {
      events,
      anchorPrevChainHash,
      totalMatchingEvents
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
