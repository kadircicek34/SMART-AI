import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { config } from '../config.js';
import { writeJsonFileAtomic, readJsonFileSync } from '../persistence/json-file.js';
import { assertPublicRemoteAddress, normalizeRemoteHostname } from '../rag/remote-url.js';
import { securityAuditLog, type SecurityAuditEventType, type SecurityAuditExportBundle } from './audit-log.js';
import {
  evaluateSecurityExportDeliveryTargetPolicy,
  type EffectiveSecurityExportDeliveryPolicy,
  type SecurityExportDeliveryTargetPolicyReason
} from './export-delivery-policy.js';
import { ensureSignedSecurityAuditExportBundle, securityExportSigningRegistry } from './export-signing.js';

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const WHITESPACE = /\s+/g;
const DELIVERY_STORE_VERSION = 5;
const MAX_DELIVERY_URL_LENGTH = 2048;
const RETRYABLE_HTTP_STATUS_CODES = new Set([408, 425, 429]);
const RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'EPIPE']);

type LookupResult = Array<{ address: string; family: number }>;

type SecurityExportDeliveryStatus = 'queued' | 'retrying' | 'succeeded' | 'failed' | 'blocked' | 'dead_letter';
export type SecurityExportDeliveryMode = 'sync' | 'async';
export type SecurityExportDeliveryIncidentStatus = 'active' | 'resolved';

type DeliveryDestination = {
  origin: string;
  host: string;
  port: number;
  matched_host_rule: string | null;
  path_hint: '/' | '/…';
  path_hash: string;
};

export type SecurityExportDeliveryRecord = {
  delivery_id: string;
  tenant_id: string;
  request_id?: string;
  source_delivery_id?: string;
  mode: SecurityExportDeliveryMode;
  requested_at: string;
  updated_at: string;
  completed_at?: string;
  status: SecurityExportDeliveryStatus;
  destination: DeliveryDestination;
  event_count: number;
  head_chain_hash: string | null;
  anchor_prev_chain_hash: string | null;
  http_status?: number;
  duration_ms?: number;
  failure_code?: string;
  failure_reason?: string;
  response_excerpt?: string;
  response_excerpt_truncated?: boolean;
  pinned_address?: string;
  pinned_address_family?: number;
  attempt_count: number;
  max_attempts: number;
  redrive_count: number;
  last_attempt_at?: string;
  next_attempt_at?: string;
  dead_lettered_at?: string;
  signature: {
    algorithm: 'Ed25519';
    key_id: string;
    timestamp: string;
    nonce: string;
    body_sha256: string;
  };
};

type PreparedDelivery = {
  deliveryId: string;
  target: {
    url: URL;
    hostname: string;
    matchedHostRule: string;
    descriptor: DeliveryDestination;
  };
  payload: string;
  headers: Record<string, string>;
  pinnedAddress: { address: string; family: number };
  signature: SecurityExportDeliveryRecord['signature'];
};

export type SecurityExportDeliveryTargetPreview = {
  allowed: boolean;
  reason: SecurityExportDeliveryTargetPreviewReason;
  policy: EffectiveSecurityExportDeliveryPolicy;
  destination: DeliveryDestination;
  matched_rule: string | null;
  pinned_address: string;
  pinned_address_family: number;
  health: SecurityExportDeliveryDestinationHealth;
};

export type SecurityExportDeliveryTargetPreviewReason = SecurityExportDeliveryTargetPolicyReason | 'destination_quarantined';

export type SecurityExportDeliveryHealthVerdict = 'healthy' | 'degraded' | 'quarantined';

export type SecurityExportDeliveryIncidentClearRequest = {
  request_id: string;
  requested_at: string;
  requested_by: string;
  note: string;
  expires_at: string;
  canary_checked_at: string;
  canary_http_status: number;
  canary_duration_ms: number;
  canary_response_excerpt: string | null;
  canary_response_excerpt_truncated: boolean;
  canary_pinned_address: string;
  canary_pinned_address_family: number;
  canary_matched_rule: string | null;
  consumed_at: string | null;
  consumed_by: string | null;
  approval_note: string | null;
};

export type SecurityExportDeliveryIncidentSummary = {
  incident_id: string;
  status: SecurityExportDeliveryIncidentStatus;
  opened_at: string;
  updated_at: string;
  clear_after: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  clear_request: SecurityExportDeliveryIncidentClearRequest | null;
  revision: number;
};

export type SecurityExportDeliveryIncident = SecurityExportDeliveryIncidentSummary & {
  tenant_id: string;
  destination: DeliveryDestination;
  matched_rule: string | null;
  latest_delivery_id: string | null;
  latest_delivery_status: SecurityExportDeliveryStatus | null;
  latest_delivery_at: string | null;
  latest_failure_code: string | null;
  latest_failure_reason: string | null;
  counts: Record<SecurityExportDeliveryStatus, number>;
  terminal_failures: number;
  dead_letters: number;
  acknowledgment_note: string | null;
  resolved_at: string | null;
  cleared_at: string | null;
  cleared_by: string | null;
  clear_note: string | null;
  clear_request: SecurityExportDeliveryIncidentClearRequest | null;
};

export type SecurityExportDeliveryDestinationHealth = {
  verdict: SecurityExportDeliveryHealthVerdict;
  total: number;
  counts: Record<SecurityExportDeliveryStatus, number>;
  terminal_failures: number;
  dead_letters: number;
  last_status: SecurityExportDeliveryStatus | null;
  last_attempt_at: string | null;
  last_http_status: number | null;
  last_failure_code: string | null;
  last_failure_reason: string | null;
  quarantined_until: string | null;
  incident_window_hours: number;
  quarantine_duration_minutes: number;
  quarantine_failure_threshold: number;
  quarantine_dead_letter_threshold: number;
  active_incident: SecurityExportDeliveryIncidentSummary | null;
};

export type SecurityExportDeliveryDestinationAnalytics = {
  destination: DeliveryDestination;
  matched_rule: string | null;
  health: SecurityExportDeliveryDestinationHealth;
  incident: SecurityExportDeliveryIncidentSummary | null;
  latest_delivery_id: string | null;
  latest_mode: SecurityExportDeliveryMode | null;
  latest_completed_at: string | null;
  redrive_count: number;
};

export type SecurityExportDeliveryAnalytics = {
  generated_at: string;
  window: {
    hours: number;
    bucket_hours: number;
    started_at: string;
    ended_at: string;
  };
  summary: {
    total_records: number;
    active_queue_count: number;
    active_destinations: number;
    quarantined_destinations: number;
    degraded_destinations: number;
    active_incidents: number;
    unacknowledged_incidents: number;
    clearable_incidents: number;
    success_rate: number;
    counts: Record<SecurityExportDeliveryStatus, number>;
  };
  incidents: SecurityExportDeliveryDestinationAnalytics[];
  destinations: SecurityExportDeliveryDestinationAnalytics[];
  timeline: Array<{
    started_at: string;
    ended_at: string;
    total: number;
    counts: Record<SecurityExportDeliveryStatus, number>;
  }>;
};

type DeliveryTransportResult = {
  statusCode: number;
  bodyText?: string;
  bodyTruncated?: boolean;
  durationMs?: number;
  contentType?: string;
};

type EncryptedValue = {
  iv: string;
  tag: string;
  data: string;
};

type DeliveryRetryMaterial = {
  delivery_id: string;
  tenant_id: string;
  request_id?: string;
  source_delivery_id?: string;
  destination_url: string;
  destination_origin: string;
  destination_host: string;
  destination_path_hash: string;
  matched_host_rule: string | null;
  redrive_count: number;
  last_redriven_at?: string;
  payload: EncryptedValue;
};

type DeliveryIdempotencyEntry = {
  tenant_id: string;
  delivery_id: string;
  key_hash: string;
  payload_sha256: string;
  created_at: string;
};

type DeliveryTargetMaterial = {
  tenant_id: string;
  destination_key: string;
  target_url: EncryptedValue;
  updated_at: string;
};

type DeliveryStoreSnapshot = {
  version: number;
  updatedAt: string;
  tenants: Record<string, unknown[]>;
  incidents?: Record<string, unknown[]>;
  retryMaterials?: unknown[];
  idempotency?: unknown[];
  targets?: unknown[];
};

type EnqueueSecurityExportDeliveryResult =
  | { ok: true; record: SecurityExportDeliveryRecord; reused: boolean }
  | { ok: false; reason: 'active_limit_exceeded'; activeDeliveries: number }
  | { ok: false; reason: 'idempotency_conflict' };

type RedriveSecurityExportDeliveryResult =
  | { ok: true; record: SecurityExportDeliveryRecord }
  | { ok: false; reason: 'active_limit_exceeded'; activeDeliveries: number };

class SecurityExportDeliveryError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly record: SecurityExportDeliveryRecord;

  constructor(message: string, options: { code: string; statusCode: number; record: SecurityExportDeliveryRecord }) {
    super(message);
    this.name = 'SecurityExportDeliveryError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.record = options.record;
  }
}

class SecurityExportDeliveryIncidentError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly incident: SecurityExportDeliveryIncident | null;

  constructor(message: string, options: { code: string; statusCode: number; incident?: SecurityExportDeliveryIncident | null }) {
    super(message);
    this.name = 'SecurityExportDeliveryIncidentError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.incident = options.incident ?? null;
  }
}

class SecurityExportDeliveryStore {
  private readonly filePath: string;
  private readonly maxRecordsPerTenant: number;
  private readonly deliveries = new Map<string, SecurityExportDeliveryRecord[]>();
  private readonly incidents = new Map<string, SecurityExportDeliveryIncident[]>();
  private readonly retryMaterials = new Map<string, DeliveryRetryMaterial>();
  private readonly idempotencyEntries = new Map<string, DeliveryIdempotencyEntry>();
  private readonly destinationTargets = new Map<string, DeliveryTargetMaterial>();

  constructor(filePath: string, maxRecordsPerTenant: number) {
    this.filePath = filePath;
    this.maxRecordsPerTenant = Math.max(1, maxRecordsPerTenant);
    this.hydrate();
  }

  list(
    tenantId: string,
    opts: {
      limit?: number;
      status?: SecurityExportDeliveryStatus;
    } = {}
  ): SecurityExportDeliveryRecord[] {
    const records = this.deliveries.get(tenantId) ?? [];
    const filtered = opts.status ? records.filter((record) => record.status === opts.status) : records;
    return filtered.slice(0, Math.max(0, opts.limit ?? 20));
  }

  listAll(tenantId: string): SecurityExportDeliveryRecord[] {
    return [...(this.deliveries.get(tenantId) ?? [])];
  }

  listIncidents(
    tenantId: string,
    opts: {
      limit?: number;
      status?: SecurityExportDeliveryIncidentStatus;
    } = {}
  ): SecurityExportDeliveryIncident[] {
    const incidents = this.incidents.get(tenantId) ?? [];
    const filtered = opts.status ? incidents.filter((incident) => incident.status === opts.status) : incidents;
    return filtered.slice(0, Math.max(0, opts.limit ?? 20));
  }

  getIncident(tenantId: string, incidentId: string): SecurityExportDeliveryIncident | null {
    const incidents = this.incidents.get(tenantId) ?? [];
    return incidents.find((incident) => incident.incident_id === incidentId) ?? null;
  }

  async rememberDestinationTarget(tenantId: string, destination: DeliveryDestination, destinationUrl: string): Promise<void> {
    const material: DeliveryTargetMaterial = {
      tenant_id: tenantId,
      destination_key: destinationAnalyticsKey(destination),
      target_url: encryptString(destinationUrl),
      updated_at: new Date().toISOString()
    };
    this.destinationTargets.set(destinationTargetLookupKey(tenantId, material.destination_key), material);
    await this.persist();
  }

  getDestinationTargetUrl(tenantId: string, destination: DeliveryDestination): string | null {
    const material = this.destinationTargets.get(destinationTargetLookupKey(tenantId, destinationAnalyticsKey(destination)));
    if (!material) {
      return null;
    }

    try {
      return decryptString(material.target_url);
    } catch {
      return null;
    }
  }

  getActiveIncidentByDestination(tenantId: string, destination: DeliveryDestination): SecurityExportDeliveryIncident | null {
    return this.getActiveIncidentByDestinationKey(tenantId, destinationAnalyticsKey(destination));
  }

  get(tenantId: string, deliveryId: string): SecurityExportDeliveryRecord | null {
    const records = this.deliveries.get(tenantId) ?? [];
    return records.find((record) => record.delivery_id === deliveryId) ?? null;
  }

  countActive(tenantId: string): number {
    const records = this.deliveries.get(tenantId) ?? [];
    return records.filter((record) => record.status === 'queued' || record.status === 'retrying').length;
  }

  listDueRetryables(now = Date.now(), force = false): SecurityExportDeliveryRecord[] {
    const due: SecurityExportDeliveryRecord[] = [];

    for (const records of this.deliveries.values()) {
      for (const record of records) {
        if (record.status !== 'queued' && record.status !== 'retrying') {
          continue;
        }

        if (!this.retryMaterials.has(record.delivery_id)) {
          continue;
        }

        if (force) {
          due.push(record);
          continue;
        }

        const nextAttemptAt = record.next_attempt_at ? Date.parse(record.next_attempt_at) : Date.parse(record.requested_at);
        if (!Number.isFinite(nextAttemptAt) || nextAttemptAt <= now) {
          due.push(record);
        }
      }
    }

    due.sort((left, right) => {
      const leftAt = Date.parse(left.next_attempt_at ?? left.requested_at);
      const rightAt = Date.parse(right.next_attempt_at ?? right.requested_at);
      return leftAt - rightAt;
    });

    return due;
  }

  findNextRetryTimestamp(): number | null {
    let nextTimestamp: number | null = null;

    for (const records of this.deliveries.values()) {
      for (const record of records) {
        if (record.status !== 'queued' && record.status !== 'retrying') {
          continue;
        }

        if (!this.retryMaterials.has(record.delivery_id)) {
          continue;
        }

        const candidate = Date.parse(record.next_attempt_at ?? record.requested_at);
        if (!Number.isFinite(candidate)) {
          continue;
        }

        if (nextTimestamp === null || candidate < nextTimestamp) {
          nextTimestamp = candidate;
        }
      }
    }

    return nextTimestamp;
  }

  async upsert(record: SecurityExportDeliveryRecord): Promise<void> {
    const current = [...(this.deliveries.get(record.tenant_id) ?? [])].filter(
      (entry) => entry.delivery_id !== record.delivery_id
    );
    current.unshift(record);

    const overflow = current.slice(this.maxRecordsPerTenant);
    if (overflow.length > 0) {
      for (const entry of overflow) {
        this.retryMaterials.delete(entry.delivery_id);
        this.deleteIdempotencyByDeliveryId(entry.delivery_id);
      }
    }

    this.deliveries.set(record.tenant_id, current.slice(0, this.maxRecordsPerTenant));
    this.syncIncidentState(record.tenant_id, record.destination);
    await this.persist();
  }

  async saveIncident(incident: SecurityExportDeliveryIncident): Promise<void> {
    this.setIncidentRecord(incident);
    await this.persist();
  }

  getRetryMaterial(deliveryId: string): DeliveryRetryMaterial | null {
    return this.retryMaterials.get(deliveryId) ?? null;
  }

  async setRetryMaterial(material: DeliveryRetryMaterial): Promise<void> {
    this.retryMaterials.set(material.delivery_id, material);
    await this.persist();
  }

  async deleteRetryMaterial(deliveryId: string): Promise<void> {
    if (!this.retryMaterials.delete(deliveryId)) {
      return;
    }

    await this.persist();
  }

  findIdempotency(tenantId: string, keyHash: string, ttlMs: number): DeliveryIdempotencyEntry | null {
    this.pruneIdempotency(ttlMs);
    const entry = this.idempotencyEntries.get(idempotencyLookupKey(tenantId, keyHash));
    if (!entry) {
      return null;
    }

    const record = this.get(tenantId, entry.delivery_id);
    if (!record) {
      this.idempotencyEntries.delete(idempotencyLookupKey(tenantId, keyHash));
      return null;
    }

    return entry;
  }

  async rememberIdempotency(entry: DeliveryIdempotencyEntry): Promise<void> {
    this.idempotencyEntries.set(idempotencyLookupKey(entry.tenant_id, entry.key_hash), entry);
    await this.persist();
  }

  reset(): void {
    this.deliveries.clear();
    this.incidents.clear();
    this.retryMaterials.clear();
    this.idempotencyEntries.clear();
    this.destinationTargets.clear();
  }

  private getActiveIncidentByDestinationKey(tenantId: string, destinationKey: string): SecurityExportDeliveryIncident | null {
    const incidents = this.incidents.get(tenantId) ?? [];
    return incidents.find(
      (incident) => incident.status === 'active' && destinationAnalyticsKey(incident.destination) === destinationKey
    ) ?? null;
  }

  private setIncidentRecord(incident: SecurityExportDeliveryIncident): void {
    const current = [...(this.incidents.get(incident.tenant_id) ?? [])].filter(
      (entry) => entry.incident_id !== incident.incident_id
    );
    current.unshift(incident);
    this.incidents.set(incident.tenant_id, current.slice(0, this.maxRecordsPerTenant));
  }

  private syncIncidentState(tenantId: string, destination: DeliveryDestination): void {
    const destinationKey = destinationAnalyticsKey(destination);
    const activeIncident = this.getActiveIncidentByDestinationKey(tenantId, destinationKey);
    const windowStartMs = Date.now() - Math.max(1, config.security.exportDeliveryIncidentWindowHours) * 60 * 60 * 1000;
    const records = (this.deliveries.get(tenantId) ?? []).filter((record) => {
      if (destinationAnalyticsKey(record.destination) !== destinationKey) {
        return false;
      }

      const timestamp = recordTimelineTimestamp(record);
      return Number.isFinite(timestamp) && timestamp >= windowStartMs;
    });

    const snapshot = buildDestinationIncidentSnapshot(records);
    const latestRecord = records[0] ?? null;
    const latestDeliveryAt = latestRecord ? latestRecord.completed_at ?? latestRecord.updated_at ?? latestRecord.requested_at : null;

    if (!activeIncident && !snapshot.thresholdBreached) {
      return;
    }

    const nowIso = new Date().toISOString();
    const clearAfter = snapshot.clearAfter ?? activeIncident?.clear_after ?? nowIso;

    if (!activeIncident) {
      const incident: SecurityExportDeliveryIncident = {
        incident_id: crypto.randomUUID(),
        tenant_id: tenantId,
        status: 'active',
        opened_at: nowIso,
        updated_at: nowIso,
        clear_after: clearAfter,
        acknowledged_at: null,
        acknowledged_by: null,
        revision: 1,
        destination: latestRecord?.destination ?? destination,
        matched_rule: latestRecord?.destination.matched_host_rule ?? destination.matched_host_rule,
        latest_delivery_id: latestRecord?.delivery_id ?? null,
        latest_delivery_status: latestRecord?.status ?? null,
        latest_delivery_at: latestDeliveryAt,
        latest_failure_code: latestRecord?.failure_code ?? null,
        latest_failure_reason: latestRecord?.failure_reason ?? null,
        counts: snapshot.counts,
        terminal_failures: snapshot.terminalFailures,
        dead_letters: snapshot.deadLetters,
        acknowledgment_note: null,
        resolved_at: null,
        cleared_at: null,
        cleared_by: null,
        clear_note: null,
        clear_request: null
      };
      this.setIncidentRecord(incident);
      securityAuditLog.record({
        tenant_id: incident.tenant_id,
        type: 'security_export_delivery_incident_opened',
        details: {
          incident_id: incident.incident_id,
          destination_host: incident.destination.host,
          path_hash: incident.destination.path_hash,
          terminal_failures: incident.terminal_failures,
          dead_letters: incident.dead_letters,
          clear_after: incident.clear_after
        }
      });
      return;
    }

    let changed = false;
    let resetAcknowledgement = false;
    let resetClearRequest = false;
    const next: SecurityExportDeliveryIncident = {
      ...activeIncident,
      destination: latestRecord?.destination ?? activeIncident.destination,
      matched_rule: latestRecord?.destination.matched_host_rule ?? activeIncident.matched_rule,
      latest_delivery_id: latestRecord?.delivery_id ?? activeIncident.latest_delivery_id,
      latest_delivery_status: latestRecord?.status ?? activeIncident.latest_delivery_status,
      latest_delivery_at: latestDeliveryAt ?? activeIncident.latest_delivery_at,
      latest_failure_code: latestRecord?.failure_code ?? activeIncident.latest_failure_code,
      latest_failure_reason: latestRecord?.failure_reason ?? activeIncident.latest_failure_reason,
      counts: snapshot.total > 0 ? snapshot.counts : activeIncident.counts,
      terminal_failures: snapshot.total > 0 ? snapshot.terminalFailures : activeIncident.terminal_failures,
      dead_letters: snapshot.total > 0 ? snapshot.deadLetters : activeIncident.dead_letters
    };

    if (snapshot.clearAfter && snapshot.clearAfter !== activeIncident.clear_after) {
      next.clear_after = snapshot.clearAfter;
      changed = true;
      if (activeIncident.acknowledged_at) {
        next.acknowledged_at = null;
        next.acknowledged_by = null;
        next.acknowledgment_note = null;
        next.clear_request = null;
        resetAcknowledgement = true;
      }
    }

    if (
      next.latest_delivery_id !== activeIncident.latest_delivery_id ||
      next.latest_delivery_status !== activeIncident.latest_delivery_status ||
      next.latest_delivery_at !== activeIncident.latest_delivery_at ||
      next.latest_failure_code !== activeIncident.latest_failure_code ||
      next.latest_failure_reason !== activeIncident.latest_failure_reason ||
      JSON.stringify(next.counts) !== JSON.stringify(activeIncident.counts) ||
      next.terminal_failures !== activeIncident.terminal_failures ||
      next.dead_letters !== activeIncident.dead_letters ||
      next.matched_rule !== activeIncident.matched_rule
    ) {
      if (activeIncident.clear_request && !activeIncident.clear_request.consumed_at) {
        next.clear_request = null;
        resetClearRequest = true;
      }
      changed = true;
    }

    if (!changed) {
      return;
    }

    next.updated_at = nowIso;
    next.revision = activeIncident.revision + 1;
    this.setIncidentRecord(next);

    if (resetAcknowledgement) {
      securityAuditLog.record({
        tenant_id: next.tenant_id,
        type: 'security_export_delivery_incident_opened',
        details: {
          incident_id: next.incident_id,
          destination_host: next.destination.host,
          path_hash: next.destination.path_hash,
          terminal_failures: next.terminal_failures,
          dead_letters: next.dead_letters,
          clear_after: next.clear_after,
          acknowledgement_reset: true
        }
      });
    }

    if (resetClearRequest && !resetAcknowledgement) {
      securityAuditLog.record({
        tenant_id: next.tenant_id,
        type: 'security_export_delivery_incident_opened',
        details: {
          incident_id: next.incident_id,
          destination_host: next.destination.host,
          path_hash: next.destination.path_hash,
          terminal_failures: next.terminal_failures,
          dead_letters: next.dead_letters,
          clear_after: next.clear_after,
          clear_request_reset: true
        }
      });
    }
  }

  private deleteIdempotencyByDeliveryId(deliveryId: string): void {
    for (const [lookupKey, entry] of this.idempotencyEntries.entries()) {
      if (entry.delivery_id === deliveryId) {
        this.idempotencyEntries.delete(lookupKey);
      }
    }
  }

  private pruneIdempotency(ttlMs: number): void {
    const now = Date.now();
    for (const [lookupKey, entry] of this.idempotencyEntries.entries()) {
      const record = this.get(entry.tenant_id, entry.delivery_id);
      if (!record) {
        this.idempotencyEntries.delete(lookupKey);
        continue;
      }

      const isActive = record.status === 'queued' || record.status === 'retrying';
      const createdAt = Date.parse(entry.created_at);
      const expired = !Number.isFinite(createdAt) || now - createdAt > ttlMs;
      if (!isActive && expired) {
        this.idempotencyEntries.delete(lookupKey);
      }
    }
  }

  private hydrate(): void {
    const parsed = readJsonFileSync<DeliveryStoreSnapshot>(this.filePath);
    if (!parsed?.tenants || typeof parsed.tenants !== 'object') {
      return;
    }

    for (const [tenantId, entries] of Object.entries(parsed.tenants)) {
      if (!Array.isArray(entries)) {
        continue;
      }

      const sanitized = entries
        .map((entry) => sanitizeDeliveryRecord(entry))
        .filter((entry): entry is SecurityExportDeliveryRecord => Boolean(entry))
        .slice(0, this.maxRecordsPerTenant);

      if (sanitized.length > 0) {
        this.deliveries.set(tenantId, sanitized);
      }
    }

    if (parsed.incidents && typeof parsed.incidents === 'object') {
      for (const [tenantId, entries] of Object.entries(parsed.incidents)) {
        if (!Array.isArray(entries)) {
          continue;
        }

        const sanitized = entries
          .map((entry) => sanitizeDeliveryIncident(entry))
          .filter((entry): entry is SecurityExportDeliveryIncident => Boolean(entry))
          .slice(0, this.maxRecordsPerTenant);

        if (sanitized.length > 0) {
          this.incidents.set(tenantId, sanitized);
        }
      }
    }

    for (const material of parsed.retryMaterials ?? []) {
      const sanitized = sanitizeRetryMaterial(material);
      if (!sanitized) {
        continue;
      }

      if (!this.get(sanitized.tenant_id, sanitized.delivery_id)) {
        continue;
      }

      this.retryMaterials.set(sanitized.delivery_id, sanitized);
    }

    for (const entry of parsed.idempotency ?? []) {
      const sanitized = sanitizeIdempotencyEntry(entry);
      if (!sanitized) {
        continue;
      }

      if (!this.get(sanitized.tenant_id, sanitized.delivery_id)) {
        continue;
      }

      this.idempotencyEntries.set(idempotencyLookupKey(sanitized.tenant_id, sanitized.key_hash), sanitized);
    }

    for (const target of parsed.targets ?? []) {
      const sanitized = sanitizeDeliveryTargetMaterial(target);
      if (!sanitized) {
        continue;
      }

      this.destinationTargets.set(destinationTargetLookupKey(sanitized.tenant_id, sanitized.destination_key), sanitized);
    }
  }

  private async persist(): Promise<void> {
    const tenants: Record<string, SecurityExportDeliveryRecord[]> = {};
    for (const [tenantId, records] of this.deliveries.entries()) {
      tenants[tenantId] = records;
    }

    const incidents: Record<string, SecurityExportDeliveryIncident[]> = {};
    for (const [tenantId, records] of this.incidents.entries()) {
      incidents[tenantId] = records;
    }

    await writeJsonFileAtomic(this.filePath, {
      version: DELIVERY_STORE_VERSION,
      updatedAt: new Date().toISOString(),
      tenants,
      incidents,
      retryMaterials: [...this.retryMaterials.values()],
      idempotency: [...this.idempotencyEntries.values()],
      targets: [...this.destinationTargets.values()]
    });
  }
}

function sanitizeString(input: string, maxLen = 220): string {
  const compact = String(input ?? '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted-api-key]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted-token]')
    .replace(/([?&](?:token|key|sig|signature|secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(CONTROL_CHARS, ' ')
    .replace(WHITESPACE, ' ')
    .trim();

  if (compact.length <= maxLen) {
    return compact;
  }

  return `${compact.slice(0, Math.max(1, maxLen - 3))}...`;
}

function sanitizeIsoTimestamp(value: unknown, fallback = Date.now()): string {
  const parsed = Date.parse(String(value ?? fallback));
  return new Date(Number.isFinite(parsed) ? parsed : fallback).toISOString();
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function sha256Base64Url(input: string): string {
  return crypto.createHash('sha256').update(input).digest('base64url');
}

function encryptString(plain: string): EncryptedValue {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.security.masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64')
  };
}

function decryptString(payload: EncryptedValue): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.security.masterKey, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
  return plain.toString('utf8');
}

function idempotencyLookupKey(tenantId: string, keyHash: string): string {
  return `${tenantId}:${keyHash}`;
}

function destinationTargetLookupKey(tenantId: string, destinationKey: string): string {
  return `${tenantId}:${destinationKey}`;
}

function normalizeDeliveryPort(url: URL): number {
  const port = url.port ? Number(url.port) : 443;
  return Number.isInteger(port) && port > 0 ? port : 443;
}

function buildDeliveryDestination(url: URL, matchedHostRule: string | null): DeliveryDestination {
  const normalizedPort = normalizeDeliveryPort(url);
  const pathMaterial = `${url.pathname || '/'}${url.search || ''}`;
  const pathHash = crypto.createHash('sha256').update(pathMaterial).digest('hex').slice(0, 16);

  return {
    origin: `${url.protocol}//${url.hostname}${normalizedPort === 443 ? '' : `:${normalizedPort}`}`,
    host: url.hostname,
    port: normalizedPort,
    matched_host_rule: matchedHostRule,
    path_hint: pathMaterial === '/' ? '/' : '/…',
    path_hash: pathHash
  };
}

function buildStatusCounts(): Record<SecurityExportDeliveryStatus, number> {
  return {
    queued: 0,
    retrying: 0,
    succeeded: 0,
    failed: 0,
    blocked: 0,
    dead_letter: 0
  };
}

type DeliveryIncidentSnapshot = {
  counts: Record<SecurityExportDeliveryStatus, number>;
  total: number;
  terminalFailures: number;
  deadLetters: number;
  lastRecord: SecurityExportDeliveryRecord | null;
  lastIncidentAtMs: number | null;
  thresholdBreached: boolean;
  clearAfter: string | null;
};

function destinationAnalyticsKey(destination: DeliveryDestination): string {
  return `${destination.origin}|${destination.path_hash}`;
}

function recordTimelineTimestamp(record: SecurityExportDeliveryRecord): number {
  return Date.parse(record.completed_at ?? record.updated_at ?? record.last_attempt_at ?? record.requested_at);
}

function isDerivedBlockFailureCode(failureCode?: string): boolean {
  return failureCode === 'policy_blocked' || failureCode === 'destination_quarantined';
}

function isTerminalIncidentRecord(record: SecurityExportDeliveryRecord): boolean {
  return (record.status === 'failed' || record.status === 'dead_letter') && !isDerivedBlockFailureCode(record.failure_code);
}

function hasIncidentThresholdBreach(options: { deadLetters: number; terminalFailures: number }): boolean {
  return (
    options.deadLetters >= Math.max(1, config.security.exportDeliveryQuarantineDeadLetterThreshold) ||
    options.terminalFailures >= Math.max(1, config.security.exportDeliveryQuarantineFailureThreshold)
  );
}

function buildDestinationIncidentSnapshot(records: SecurityExportDeliveryRecord[]): DeliveryIncidentSnapshot {
  const counts = buildStatusCounts();
  let terminalFailures = 0;
  let deadLetters = 0;
  let lastRecord: SecurityExportDeliveryRecord | null = null;
  let lastIncidentAtMs: number | null = null;

  for (const record of records) {
    counts[record.status] += 1;
    if (!lastRecord) {
      lastRecord = record;
    }
    if (record.status === 'dead_letter') {
      deadLetters += 1;
    }
    if (isTerminalIncidentRecord(record)) {
      terminalFailures += 1;
      const timestamp = recordTimelineTimestamp(record);
      if (Number.isFinite(timestamp) && (!lastIncidentAtMs || timestamp > lastIncidentAtMs)) {
        lastIncidentAtMs = timestamp;
      }
    }
  }

  const thresholdBreached = hasIncidentThresholdBreach({ deadLetters, terminalFailures });
  const clearAfter =
    thresholdBreached && lastIncidentAtMs && Number.isFinite(lastIncidentAtMs)
      ? new Date(lastIncidentAtMs + Math.max(1, config.security.exportDeliveryQuarantineDurationMinutes) * 60 * 1000).toISOString()
      : null;

  return {
    counts,
    total: records.length,
    terminalFailures,
    deadLetters,
    lastRecord,
    lastIncidentAtMs,
    thresholdBreached,
    clearAfter
  };
}

function isQuarantineTriggered(options: {
  deadLetters: number;
  terminalFailures: number;
  lastIncidentAtMs: number | null;
  now: number;
}): { active: boolean; quarantinedUntil: string | null } {
  const durationMs = Math.max(1, config.security.exportDeliveryQuarantineDurationMinutes) * 60 * 1000;
  const deadLetterThreshold = Math.max(1, config.security.exportDeliveryQuarantineDeadLetterThreshold);
  const failureThreshold = Math.max(1, config.security.exportDeliveryQuarantineFailureThreshold);
  const thresholdBreached =
    options.deadLetters >= deadLetterThreshold || options.terminalFailures >= failureThreshold;

  if (!thresholdBreached || !options.lastIncidentAtMs || !Number.isFinite(options.lastIncidentAtMs)) {
    return {
      active: false,
      quarantinedUntil: null
    };
  }

  const quarantineEndsAtMs = options.lastIncidentAtMs + durationMs;
  if (quarantineEndsAtMs <= options.now) {
    return {
      active: false,
      quarantinedUntil: null
    };
  }

  return {
    active: true,
    quarantinedUntil: new Date(quarantineEndsAtMs).toISOString()
  };
}

function toIncidentSummary(incident: SecurityExportDeliveryIncident | null): SecurityExportDeliveryIncidentSummary | null {
  if (!incident) {
    return null;
  }

  return {
    incident_id: incident.incident_id,
    status: incident.status,
    opened_at: incident.opened_at,
    updated_at: incident.updated_at,
    clear_after: incident.clear_after,
    acknowledged_at: incident.acknowledged_at,
    acknowledged_by: incident.acknowledged_by,
    clear_request: incident.clear_request,
    revision: incident.revision
  };
}

function buildDestinationHealth(
  records: SecurityExportDeliveryRecord[],
  now: number,
  activeIncident: SecurityExportDeliveryIncident | null = null
): SecurityExportDeliveryDestinationHealth {
  const snapshot = buildDestinationIncidentSnapshot(records);
  const quarantine = isQuarantineTriggered({
    deadLetters: snapshot.deadLetters,
    terminalFailures: snapshot.terminalFailures,
    lastIncidentAtMs: snapshot.lastIncidentAtMs,
    now
  });
  const incidentSummary = toIncidentSummary(activeIncident);
  const degraded =
    !quarantine.active &&
    !incidentSummary &&
    (snapshot.terminalFailures > 0 || snapshot.counts.blocked > 0 || snapshot.counts.retrying > 0 || snapshot.counts.queued > 0);

  return {
    verdict: quarantine.active || Boolean(incidentSummary) ? 'quarantined' : degraded ? 'degraded' : 'healthy',
    total: snapshot.total,
    counts: snapshot.counts,
    terminal_failures: snapshot.terminalFailures,
    dead_letters: snapshot.deadLetters,
    last_status: snapshot.lastRecord?.status ?? null,
    last_attempt_at: snapshot.lastRecord?.last_attempt_at ?? snapshot.lastRecord?.updated_at ?? snapshot.lastRecord?.requested_at ?? null,
    last_http_status: snapshot.lastRecord?.http_status ?? null,
    last_failure_code: snapshot.lastRecord?.failure_code ?? null,
    last_failure_reason: snapshot.lastRecord?.failure_reason ?? null,
    quarantined_until: incidentSummary?.clear_after ?? quarantine.quarantinedUntil,
    incident_window_hours: Math.max(1, config.security.exportDeliveryIncidentWindowHours),
    quarantine_duration_minutes: Math.max(1, config.security.exportDeliveryQuarantineDurationMinutes),
    quarantine_failure_threshold: Math.max(1, config.security.exportDeliveryQuarantineFailureThreshold),
    quarantine_dead_letter_threshold: Math.max(1, config.security.exportDeliveryQuarantineDeadLetterThreshold),
    active_incident: incidentSummary
  };
}

function buildDestinationAnalytics(records: SecurityExportDeliveryRecord[], now: number): SecurityExportDeliveryDestinationAnalytics | null {
  if (records.length === 0) {
    return null;
  }

  const latest = records[0];
  const activeIncident = deliveryStore.getActiveIncidentByDestination(latest.tenant_id, latest.destination);
  return {
    destination: latest.destination,
    matched_rule: latest.destination.matched_host_rule,
    health: buildDestinationHealth(records, now, activeIncident),
    incident: toIncidentSummary(activeIncident),
    latest_delivery_id: latest.delivery_id,
    latest_mode: latest.mode,
    latest_completed_at: latest.completed_at ?? latest.updated_at ?? latest.requested_at,
    redrive_count: records.reduce((max, record) => Math.max(max, record.redrive_count ?? 0), 0)
  };
}

function buildDestinationAnalyticsFromIncident(
  incident: SecurityExportDeliveryIncident,
  now: number
): SecurityExportDeliveryDestinationAnalytics {
  return {
    destination: incident.destination,
    matched_rule: incident.matched_rule,
    health: {
      verdict: 'quarantined',
      total: Object.values(incident.counts).reduce((sum, value) => sum + value, 0),
      counts: incident.counts,
      terminal_failures: incident.terminal_failures,
      dead_letters: incident.dead_letters,
      last_status: incident.latest_delivery_status,
      last_attempt_at: incident.latest_delivery_at,
      last_http_status: null,
      last_failure_code: incident.latest_failure_code,
      last_failure_reason: incident.latest_failure_reason,
      quarantined_until: incident.clear_after,
      incident_window_hours: Math.max(1, config.security.exportDeliveryIncidentWindowHours),
      quarantine_duration_minutes: Math.max(1, config.security.exportDeliveryQuarantineDurationMinutes),
      quarantine_failure_threshold: Math.max(1, config.security.exportDeliveryQuarantineFailureThreshold),
      quarantine_dead_letter_threshold: Math.max(1, config.security.exportDeliveryQuarantineDeadLetterThreshold),
      active_incident: toIncidentSummary(incident)
    },
    incident: toIncidentSummary(incident),
    latest_delivery_id: incident.latest_delivery_id,
    latest_mode: null,
    latest_completed_at: incident.latest_delivery_at ?? incident.updated_at,
    redrive_count: 0
  };
}

function getDestinationAnalyticsForTenant(
  tenantId: string,
  options: {
    windowHours?: number;
    now?: number;
  } = {}
): SecurityExportDeliveryDestinationAnalytics[] {
  const now = options.now ?? Date.now();
  const windowHours = Math.max(1, Math.trunc(options.windowHours ?? config.security.exportDeliveryIncidentWindowHours));
  const windowStartMs = now - windowHours * 60 * 60 * 1000;
  const grouped = new Map<string, SecurityExportDeliveryRecord[]>();

  for (const record of deliveryStore.listAll(tenantId)) {
    const timestamp = recordTimelineTimestamp(record);
    if (!Number.isFinite(timestamp) || timestamp < windowStartMs) {
      continue;
    }

    const key = destinationAnalyticsKey(record.destination);
    const records = grouped.get(key) ?? [];
    records.push(record);
    grouped.set(key, records);
  }

  const entries = [...grouped.values()]
    .map((records) => buildDestinationAnalytics(records, now))
    .filter((entry): entry is SecurityExportDeliveryDestinationAnalytics => Boolean(entry));

  const seenKeys = new Set(entries.map((entry) => destinationAnalyticsKey(entry.destination)));
  for (const incident of deliveryStore.listIncidents(tenantId, { status: 'active', limit: config.security.exportDeliveryMaxRecordsPerTenant })) {
    const key = destinationAnalyticsKey(incident.destination);
    if (seenKeys.has(key)) {
      continue;
    }

    entries.push(buildDestinationAnalyticsFromIncident(incident, now));
    seenKeys.add(key);
  }

  return entries.sort((left, right) => {
      const severity = (entry: SecurityExportDeliveryDestinationAnalytics) => {
        if (entry.health.verdict === 'quarantined') return 3;
        if (entry.health.verdict === 'degraded') return 2;
        return 1;
      };

      return (
        severity(right) - severity(left) ||
        right.health.dead_letters - left.health.dead_letters ||
        right.health.terminal_failures - left.health.terminal_failures ||
        Date.parse(right.latest_completed_at ?? '') - Date.parse(left.latest_completed_at ?? '')
      );
    });
}

function buildRetryMaterial(options: {
  record: Pick<SecurityExportDeliveryRecord, 'delivery_id' | 'tenant_id' | 'request_id' | 'source_delivery_id' | 'redrive_count'>;
  destinationUrl: string;
  destination: DeliveryDestination;
  payload: string;
  lastRedrivenAt?: string;
}): DeliveryRetryMaterial {
  return {
    delivery_id: options.record.delivery_id,
    tenant_id: options.record.tenant_id,
    request_id: options.record.request_id,
    source_delivery_id: options.record.source_delivery_id,
    destination_url: String(options.destinationUrl ?? '').trim(),
    destination_origin: options.destination.origin,
    destination_host: options.destination.host,
    destination_path_hash: options.destination.path_hash,
    matched_host_rule: options.destination.matched_host_rule,
    redrive_count: Math.max(0, options.record.redrive_count ?? 0),
    last_redriven_at: options.lastRedrivenAt,
    payload: encryptString(options.payload)
  };
}

function assertRetryMaterialFingerprint(record: SecurityExportDeliveryRecord, retryMaterial: DeliveryRetryMaterial): void {
  if (
    record.destination.origin !== retryMaterial.destination_origin ||
    record.destination.host !== retryMaterial.destination_host ||
    record.destination.path_hash !== retryMaterial.destination_path_hash ||
    (record.destination.matched_host_rule ?? null) !== (retryMaterial.matched_host_rule ?? null)
  ) {
    throw new Error('Retry material fingerprint does not match the queued delivery destination.');
  }
}

function sanitizeDeliveryRecord(value: unknown): SecurityExportDeliveryRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<SecurityExportDeliveryRecord>;
  if (!candidate.delivery_id || !candidate.tenant_id || !candidate.destination) {
    return null;
  }

  const destination = candidate.destination as DeliveryDestination;
  if (!destination.host || !destination.origin) {
    return null;
  }

  const allowedStatuses: SecurityExportDeliveryStatus[] = ['queued', 'retrying', 'succeeded', 'failed', 'blocked', 'dead_letter'];
  const status = allowedStatuses.includes(candidate.status as SecurityExportDeliveryStatus)
    ? (candidate.status as SecurityExportDeliveryStatus)
    : null;

  if (!status) {
    return null;
  }

  const mode = candidate.mode === 'async' ? 'async' : 'sync';
  const defaultAttempts = mode === 'async' || status === 'queued' || status === 'retrying' ? 0 : 1;

  return {
    delivery_id: sanitizeString(candidate.delivery_id, 96),
    tenant_id: sanitizeString(candidate.tenant_id, 128),
    request_id: candidate.request_id ? sanitizeString(candidate.request_id, 96) : undefined,
    source_delivery_id: candidate.source_delivery_id ? sanitizeString(candidate.source_delivery_id, 96) : undefined,
    mode,
    requested_at: sanitizeIsoTimestamp(candidate.requested_at),
    updated_at: sanitizeIsoTimestamp(candidate.updated_at ?? candidate.completed_at ?? candidate.requested_at),
    completed_at: candidate.completed_at ? sanitizeIsoTimestamp(candidate.completed_at) : undefined,
    status,
    destination: {
      origin: sanitizeString(destination.origin, 180),
      host: sanitizeString(destination.host, 180),
      port: Number(destination.port || 443),
      matched_host_rule: destination.matched_host_rule ? sanitizeString(destination.matched_host_rule, 180) : null,
      path_hint: destination.path_hint === '/' ? '/' : '/…',
      path_hash: sanitizeString(destination.path_hash, 32)
    },
    event_count: Number.isFinite(candidate.event_count) ? Number(candidate.event_count) : 0,
    head_chain_hash: candidate.head_chain_hash ? sanitizeString(candidate.head_chain_hash, 96) : null,
    anchor_prev_chain_hash: candidate.anchor_prev_chain_hash ? sanitizeString(candidate.anchor_prev_chain_hash, 96) : null,
    http_status: Number.isFinite(candidate.http_status) ? Number(candidate.http_status) : undefined,
    duration_ms: Number.isFinite(candidate.duration_ms) ? Number(candidate.duration_ms) : undefined,
    failure_code: candidate.failure_code ? sanitizeString(candidate.failure_code, 96) : undefined,
    failure_reason: candidate.failure_reason ? sanitizeString(candidate.failure_reason, 180) : undefined,
    response_excerpt: candidate.response_excerpt ? sanitizeString(candidate.response_excerpt, 220) : undefined,
    response_excerpt_truncated: Boolean(candidate.response_excerpt_truncated),
    pinned_address: candidate.pinned_address ? sanitizeString(candidate.pinned_address, 72) : undefined,
    pinned_address_family: Number.isFinite(candidate.pinned_address_family) ? Number(candidate.pinned_address_family) : undefined,
    attempt_count: Number.isFinite(candidate.attempt_count) ? Math.max(0, Number(candidate.attempt_count)) : defaultAttempts,
    max_attempts: Number.isFinite(candidate.max_attempts) ? Math.max(1, Number(candidate.max_attempts)) : Math.max(1, defaultAttempts),
    redrive_count: Number.isFinite(candidate.redrive_count) ? Math.max(0, Number(candidate.redrive_count)) : 0,
    last_attempt_at: candidate.last_attempt_at ? sanitizeIsoTimestamp(candidate.last_attempt_at) : undefined,
    next_attempt_at: candidate.next_attempt_at ? sanitizeIsoTimestamp(candidate.next_attempt_at) : undefined,
    dead_lettered_at: candidate.dead_lettered_at ? sanitizeIsoTimestamp(candidate.dead_lettered_at) : undefined,
    signature: {
      algorithm: 'Ed25519',
      key_id: sanitizeString(candidate.signature?.key_id ?? 'unknown', 96),
      timestamp: sanitizeIsoTimestamp(candidate.signature?.timestamp ?? Date.now()),
      nonce: sanitizeString(candidate.signature?.nonce ?? crypto.randomUUID(), 96),
      body_sha256: sanitizeString(candidate.signature?.body_sha256 ?? '', 96)
    }
  };
}

function sanitizeDeliveryIncidentClearRequest(value: unknown): SecurityExportDeliveryIncidentClearRequest | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<SecurityExportDeliveryIncidentClearRequest>;
  if (!candidate.request_id || !candidate.requested_at || !candidate.requested_by || !candidate.note || !candidate.expires_at || !candidate.canary_checked_at) {
    return null;
  }

  return {
    request_id: sanitizeString(candidate.request_id, 96),
    requested_at: sanitizeIsoTimestamp(candidate.requested_at),
    requested_by: sanitizeString(candidate.requested_by, 128),
    note: sanitizeString(candidate.note, 280),
    expires_at: sanitizeIsoTimestamp(candidate.expires_at),
    canary_checked_at: sanitizeIsoTimestamp(candidate.canary_checked_at),
    canary_http_status: Number.isFinite(candidate.canary_http_status) ? Math.max(0, Number(candidate.canary_http_status)) : 0,
    canary_duration_ms: Number.isFinite(candidate.canary_duration_ms) ? Math.max(0, Number(candidate.canary_duration_ms)) : 0,
    canary_response_excerpt: candidate.canary_response_excerpt ? sanitizeString(candidate.canary_response_excerpt, 220) : null,
    canary_response_excerpt_truncated: Boolean(candidate.canary_response_excerpt_truncated),
    canary_pinned_address: sanitizeString(candidate.canary_pinned_address ?? 'unknown', 128),
    canary_pinned_address_family: Number.isFinite(candidate.canary_pinned_address_family) ? Math.max(0, Number(candidate.canary_pinned_address_family)) : 0,
    canary_matched_rule: candidate.canary_matched_rule ? sanitizeString(candidate.canary_matched_rule, 160) : null,
    consumed_at: candidate.consumed_at ? sanitizeIsoTimestamp(candidate.consumed_at) : null,
    consumed_by: candidate.consumed_by ? sanitizeString(candidate.consumed_by, 128) : null,
    approval_note: candidate.approval_note ? sanitizeString(candidate.approval_note, 280) : null
  };
}

function sanitizeDeliveryIncident(value: unknown): SecurityExportDeliveryIncident | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<SecurityExportDeliveryIncident>;
  if (!candidate.incident_id || !candidate.tenant_id || !candidate.destination) {
    return null;
  }

  const destination = candidate.destination as DeliveryDestination;
  if (!destination.host || !destination.origin) {
    return null;
  }

  const status = candidate.status === 'resolved' ? 'resolved' : candidate.status === 'active' ? 'active' : null;
  if (!status) {
    return null;
  }

  const counts = buildStatusCounts();
  const candidateCounts = candidate.counts as Partial<Record<SecurityExportDeliveryStatus, number>> | undefined;
  for (const key of Object.keys(counts) as SecurityExportDeliveryStatus[]) {
    if (candidateCounts && Number.isFinite(candidateCounts[key])) {
      counts[key] = Math.max(0, Number(candidateCounts[key]));
    }
  }

  return {
    incident_id: sanitizeString(candidate.incident_id, 96),
    tenant_id: sanitizeString(candidate.tenant_id, 128),
    status,
    opened_at: sanitizeIsoTimestamp(candidate.opened_at),
    updated_at: sanitizeIsoTimestamp(candidate.updated_at ?? candidate.opened_at),
    clear_after: sanitizeIsoTimestamp(candidate.clear_after ?? candidate.updated_at ?? candidate.opened_at),
    acknowledged_at: candidate.acknowledged_at ? sanitizeIsoTimestamp(candidate.acknowledged_at) : null,
    acknowledged_by: candidate.acknowledged_by ? sanitizeString(candidate.acknowledged_by, 128) : null,
    revision: Number.isFinite(candidate.revision) ? Math.max(1, Number(candidate.revision)) : 1,
    destination: {
      origin: sanitizeString(destination.origin, 180),
      host: sanitizeString(destination.host, 180),
      port: Number(destination.port || 443),
      matched_host_rule: destination.matched_host_rule ? sanitizeString(destination.matched_host_rule, 180) : null,
      path_hint: destination.path_hint === '/' ? '/' : '/…',
      path_hash: sanitizeString(destination.path_hash, 32)
    },
    matched_rule: candidate.matched_rule ? sanitizeString(candidate.matched_rule, 180) : null,
    latest_delivery_id: candidate.latest_delivery_id ? sanitizeString(candidate.latest_delivery_id, 96) : null,
    latest_delivery_status: ['queued', 'retrying', 'succeeded', 'failed', 'blocked', 'dead_letter'].includes(
      String(candidate.latest_delivery_status ?? '')
    )
      ? (candidate.latest_delivery_status as SecurityExportDeliveryStatus)
      : null,
    latest_delivery_at: candidate.latest_delivery_at ? sanitizeIsoTimestamp(candidate.latest_delivery_at) : null,
    latest_failure_code: candidate.latest_failure_code ? sanitizeString(candidate.latest_failure_code, 96) : null,
    latest_failure_reason: candidate.latest_failure_reason ? sanitizeString(candidate.latest_failure_reason, 180) : null,
    counts,
    terminal_failures: Number.isFinite(candidate.terminal_failures) ? Math.max(0, Number(candidate.terminal_failures)) : 0,
    dead_letters: Number.isFinite(candidate.dead_letters) ? Math.max(0, Number(candidate.dead_letters)) : 0,
    acknowledgment_note: candidate.acknowledgment_note ? sanitizeString(candidate.acknowledgment_note, 280) : null,
    resolved_at: candidate.resolved_at ? sanitizeIsoTimestamp(candidate.resolved_at) : null,
    cleared_at: candidate.cleared_at ? sanitizeIsoTimestamp(candidate.cleared_at) : null,
    cleared_by: candidate.cleared_by ? sanitizeString(candidate.cleared_by, 128) : null,
    clear_note: candidate.clear_note ? sanitizeString(candidate.clear_note, 280) : null,
    clear_request: sanitizeDeliveryIncidentClearRequest(candidate.clear_request)
  };
}

function sanitizeRetryMaterial(value: unknown): DeliveryRetryMaterial | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<DeliveryRetryMaterial>;
  if (
    !candidate.delivery_id ||
    !candidate.tenant_id ||
    !candidate.destination_url ||
    !candidate.destination_origin ||
    !candidate.destination_host ||
    !candidate.destination_path_hash ||
    !candidate.payload
  ) {
    return null;
  }

  const payload = candidate.payload as EncryptedValue;
  if (!payload.iv || !payload.tag || !payload.data) {
    return null;
  }

  return {
    delivery_id: sanitizeString(candidate.delivery_id, 96),
    tenant_id: sanitizeString(candidate.tenant_id, 128),
    request_id: candidate.request_id ? sanitizeString(candidate.request_id, 96) : undefined,
    source_delivery_id: candidate.source_delivery_id ? sanitizeString(candidate.source_delivery_id, 96) : undefined,
    destination_url: String(candidate.destination_url).trim().slice(0, MAX_DELIVERY_URL_LENGTH),
    destination_origin: sanitizeString(candidate.destination_origin, 220),
    destination_host: sanitizeString(candidate.destination_host, 180),
    destination_path_hash: sanitizeString(candidate.destination_path_hash, 32),
    matched_host_rule: candidate.matched_host_rule ? sanitizeString(candidate.matched_host_rule, 180) : null,
    redrive_count: Number.isFinite(candidate.redrive_count) ? Math.max(0, Number(candidate.redrive_count)) : 0,
    last_redriven_at: candidate.last_redriven_at ? sanitizeIsoTimestamp(candidate.last_redriven_at) : undefined,
    payload: {
      iv: String(payload.iv),
      tag: String(payload.tag),
      data: String(payload.data)
    }
  };
}

function sanitizeIdempotencyEntry(value: unknown): DeliveryIdempotencyEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<DeliveryIdempotencyEntry>;
  if (!candidate.tenant_id || !candidate.delivery_id || !candidate.key_hash || !candidate.payload_sha256) {
    return null;
  }

  return {
    tenant_id: sanitizeString(candidate.tenant_id, 128),
    delivery_id: sanitizeString(candidate.delivery_id, 96),
    key_hash: sanitizeString(candidate.key_hash, 128),
    payload_sha256: sanitizeString(candidate.payload_sha256, 96),
    created_at: sanitizeIsoTimestamp(candidate.created_at)
  };
}

function sanitizeDeliveryTargetMaterial(value: unknown): DeliveryTargetMaterial | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<DeliveryTargetMaterial>;
  const targetUrl = candidate.target_url as EncryptedValue | undefined;
  if (!candidate.tenant_id || !candidate.destination_key || !targetUrl?.iv || !targetUrl.tag || !targetUrl.data) {
    return null;
  }

  return {
    tenant_id: sanitizeString(candidate.tenant_id, 128),
    destination_key: sanitizeString(candidate.destination_key, 220),
    target_url: {
      iv: String(targetUrl.iv),
      tag: String(targetUrl.tag),
      data: String(targetUrl.data)
    },
    updated_at: sanitizeIsoTimestamp(candidate.updated_at)
  };
}

function buildSignedHeaders(
  tenantId: string,
  deliveryId: string,
  destinationUrl: URL,
  payload: string,
  bundle: SecurityAuditExportBundle
): { headers: Record<string, string>; signature: SecurityExportDeliveryRecord['signature'] } {
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const bodySha256 = crypto.createHash('sha256').update(payload).digest('hex');
  const bodyDigest = crypto.createHash('sha256').update(payload).digest('base64');
  const signedBundle = ensureSignedSecurityAuditExportBundle(bundle);
  const bundleSignature = signedBundle.signature;
  const signingInput = [
    tenantId,
    deliveryId,
    timestamp,
    nonce,
    destinationUrl.pathname || '/',
    bodySha256,
    signedBundle.integrity.headChainHash ?? '',
    bundleSignature?.key_id ?? '',
    bundleSignature?.payload_sha256 ?? ''
  ].join('\n');
  const deliverySignature = securityExportSigningRegistry.signDetachedText(signingInput);

  return {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-digest': `sha-256=:${bodyDigest}:`,
      'user-agent': config.security.exportDeliveryUserAgent,
      'x-smart-ai-delivery-id': deliveryId,
      'x-smart-ai-tenant-id': tenantId,
      'x-smart-ai-head-chain-hash': signedBundle.integrity.headChainHash ?? '',
      'x-smart-ai-event-count': String(signedBundle.data.length),
      'x-smart-ai-bundle-signature-key-id': bundleSignature?.key_id ?? '',
      'x-smart-ai-signature-alg': 'Ed25519',
      'x-smart-ai-signature-key-id': deliverySignature.key_id,
      'x-smart-ai-signature': `ed25519=:${deliverySignature.signature}:`,
      'x-smart-ai-signature-input': `keyid="${deliverySignature.key_id}",created="${timestamp}",nonce="${nonce}",body-sha-256="${bodySha256}",bundle-key-id="${bundleSignature?.key_id ?? ''}"`
    },
    signature: {
      algorithm: 'Ed25519',
      key_id: deliverySignature.key_id,
      timestamp,
      nonce,
      body_sha256: bodySha256
    }
  };
}

function computeDeliveryIdempotencyPayloadHash(destinationUrl: string, bundle: SecurityAuditExportBundle): string {
  return sha256Hex(
    JSON.stringify({
      destinationUrl: String(destinationUrl ?? '').trim(),
      tenantId: bundle.tenant_id,
      headChainHash: bundle.integrity.headChainHash ?? null,
      anchorPrevChainHash: bundle.integrity.anchorPrevChainHash ?? null,
      totalMatchingEvents: bundle.filter.total_matching_events,
      exportedEventIds: bundle.data.map((event) => event.event_id)
    })
  );
}

function buildQueuedSignature(payload: string, requestedAt: string, bundle: SecurityAuditExportBundle): SecurityExportDeliveryRecord['signature'] {
  return {
    algorithm: 'Ed25519',
    key_id: bundle.signature?.key_id ?? securityExportSigningRegistry.getActiveKeySummary().key_id,
    timestamp: requestedAt,
    nonce: crypto.randomUUID(),
    body_sha256: sha256Hex(payload)
  };
}

function buildQueuedRecord(options: {
  tenantId: string;
  requestId?: string;
  deliveryId: string;
  requestedAt: string;
  destination: DeliveryDestination;
  bundle: SecurityAuditExportBundle;
  payload: string;
  maxAttempts: number;
  sourceDeliveryId?: string;
  redriveCount?: number;
}): SecurityExportDeliveryRecord {
  return {
    delivery_id: options.deliveryId,
    tenant_id: options.tenantId,
    request_id: options.requestId,
    source_delivery_id: options.sourceDeliveryId,
    mode: 'async',
    requested_at: options.requestedAt,
    updated_at: options.requestedAt,
    status: 'queued',
    destination: options.destination,
    event_count: options.bundle.data.length,
    head_chain_hash: options.bundle.integrity.headChainHash,
    anchor_prev_chain_hash: options.bundle.integrity.anchorPrevChainHash,
    attempt_count: 0,
    max_attempts: options.maxAttempts,
    redrive_count: Math.max(0, options.redriveCount ?? 0),
    next_attempt_at: options.requestedAt,
    signature: buildQueuedSignature(options.payload, options.requestedAt, options.bundle)
  };
}

function buildErrorRecord(options: {
  tenantId: string;
  requestId?: string;
  deliveryId: string;
  sourceDeliveryId?: string;
  mode: SecurityExportDeliveryMode;
  requestedAt: string;
  updatedAt?: string;
  completedAt?: string;
  status: Extract<SecurityExportDeliveryStatus, 'failed' | 'blocked' | 'retrying' | 'dead_letter'>;
  destination: DeliveryDestination;
  bundle: SecurityAuditExportBundle;
  signature: SecurityExportDeliveryRecord['signature'];
  attemptCount: number;
  maxAttempts: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  deadLetteredAt?: string;
  failureCode: string;
  failureReason: string;
  httpStatus?: number;
  durationMs?: number;
  responseExcerpt?: string;
  responseExcerptTruncated?: boolean;
  pinnedAddress?: string;
  pinnedAddressFamily?: number;
  redriveCount?: number;
}): SecurityExportDeliveryRecord {
  const updatedAt = options.updatedAt ?? new Date().toISOString();

  return {
    delivery_id: options.deliveryId,
    tenant_id: options.tenantId,
    request_id: options.requestId,
    source_delivery_id: options.sourceDeliveryId,
    mode: options.mode,
    requested_at: options.requestedAt,
    updated_at: updatedAt,
    completed_at: options.completedAt,
    status: options.status,
    destination: options.destination,
    event_count: options.bundle.data.length,
    head_chain_hash: options.bundle.integrity.headChainHash,
    anchor_prev_chain_hash: options.bundle.integrity.anchorPrevChainHash,
    http_status: options.httpStatus,
    duration_ms: options.durationMs,
    failure_code: options.failureCode,
    failure_reason: sanitizeString(options.failureReason, 180),
    response_excerpt: options.responseExcerpt ? sanitizeString(options.responseExcerpt, 220) : undefined,
    response_excerpt_truncated: options.responseExcerptTruncated,
    pinned_address: options.pinnedAddress,
    pinned_address_family: options.pinnedAddressFamily,
    attempt_count: options.attemptCount,
    max_attempts: options.maxAttempts,
    redrive_count: Math.max(0, options.redriveCount ?? 0),
    last_attempt_at: options.lastAttemptAt,
    next_attempt_at: options.nextAttemptAt,
    dead_lettered_at: options.deadLetteredAt,
    signature: options.signature
  };
}

function buildSuccessRecord(options: {
  tenantId: string;
  requestId?: string;
  deliveryId: string;
  sourceDeliveryId?: string;
  mode: SecurityExportDeliveryMode;
  requestedAt: string;
  destination: DeliveryDestination;
  bundle: SecurityAuditExportBundle;
  signature: SecurityExportDeliveryRecord['signature'];
  attemptCount: number;
  maxAttempts: number;
  lastAttemptAt?: string;
  httpStatus: number;
  durationMs: number;
  responseExcerpt?: string;
  responseExcerptTruncated?: boolean;
  pinnedAddress: string;
  pinnedAddressFamily: number;
  redriveCount?: number;
}): SecurityExportDeliveryRecord {
  const completedAt = new Date().toISOString();

  return {
    delivery_id: options.deliveryId,
    tenant_id: options.tenantId,
    request_id: options.requestId,
    source_delivery_id: options.sourceDeliveryId,
    mode: options.mode,
    requested_at: options.requestedAt,
    updated_at: completedAt,
    completed_at: completedAt,
    status: 'succeeded',
    destination: options.destination,
    event_count: options.bundle.data.length,
    head_chain_hash: options.bundle.integrity.headChainHash,
    anchor_prev_chain_hash: options.bundle.integrity.anchorPrevChainHash,
    http_status: options.httpStatus,
    duration_ms: options.durationMs,
    response_excerpt: options.responseExcerpt ? sanitizeString(options.responseExcerpt, 220) : undefined,
    response_excerpt_truncated: options.responseExcerptTruncated,
    pinned_address: options.pinnedAddress,
    pinned_address_family: options.pinnedAddressFamily,
    attempt_count: options.attemptCount,
    max_attempts: options.maxAttempts,
    redrive_count: Math.max(0, options.redriveCount ?? 0),
    last_attempt_at: options.lastAttemptAt,
    signature: options.signature
  };
}

function normalizeLookupResult(hostname: string, records: LookupResult): LookupResult {
  const normalized: LookupResult = [];

  for (const record of records) {
    const address = String(record?.address ?? '').trim();
    const family = Number(record?.family ?? 0);
    if (!address || (family !== 4 && family !== 6)) {
      continue;
    }

    assertPublicRemoteAddress(address);
    normalized.push({ address, family });
  }

  if (normalized.length === 0) {
    throw new Error(`No public DNS answer returned for ${hostname}.`);
  }

  normalized.sort((left, right) => left.family - right.family);
  return normalized;
}

async function defaultLookup(hostname: string): Promise<LookupResult> {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return normalizeLookupResult(hostname, records.map((record) => ({ address: record.address, family: record.family })));
}

let lookupForTests: ((hostname: string) => Promise<LookupResult>) | undefined;
let transportForTests: ((prepared: PreparedDelivery) => Promise<DeliveryTransportResult>) | undefined;
let autoProcessEnabled = true;
let retryTimer: NodeJS.Timeout | null = null;
let retryChain: Promise<void> = Promise.resolve();
const retryInFlight = new Set<string>();
const deliveryStore = new SecurityExportDeliveryStore(
  config.storage.securityExportDeliveryStoreFile,
  config.security.exportDeliveryMaxRecordsPerTenant
);

function getLookup(): (hostname: string) => Promise<LookupResult> {
  return lookupForTests ?? defaultLookup;
}

function clearRetryTimer(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleRetryProcessing(): void {
  if (!autoProcessEnabled) {
    clearRetryTimer();
    return;
  }

  clearRetryTimer();
  const nextTimestamp = deliveryStore.findNextRetryTimestamp();
  if (nextTimestamp === null) {
    return;
  }

  const delayMs = Math.max(0, nextTimestamp - Date.now());
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void drainRetryQueue();
  }, delayMs);
  retryTimer.unref?.();
}

function queueRetryProcessingSoon(): void {
  if (!autoProcessEnabled) {
    return;
  }

  const handle = setTimeout(() => {
    void drainRetryQueue();
  }, 0);
  handle.unref?.();
}

function normalizeDeliveryTargetDestination(destinationUrl: string): {
  url: URL;
  hostname: string;
  port: number;
  path: string;
} {
  const rawDestinationUrl = String(destinationUrl ?? '').trim();
  if (!rawDestinationUrl || rawDestinationUrl.length > MAX_DELIVERY_URL_LENGTH) {
    throw new Error('Destination URL is missing or too long.');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawDestinationUrl);
  } catch {
    throw new Error('Destination URL is invalid.');
  }

  if (parsedUrl.protocol !== 'https:') {
    throw new Error('Security export delivery requires an HTTPS destination URL.');
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('Destination URL must not contain embedded credentials.');
  }

  const hostname = normalizeRemoteHostname(parsedUrl.hostname);
  if (!hostname) {
    throw new Error('Destination hostname is invalid.');
  }
  parsedUrl.hostname = hostname;

  const family = net.isIP(hostname);
  if (family > 0) {
    assertPublicRemoteAddress(hostname);
  }

  if (family > 0 && !config.security.exportDeliveryAllowIpLiterals) {
    throw new Error('IP-literal delivery targets are disabled. Use a DNS hostname allowlisted in delivery policy.');
  }

  if (family === 0 && !hostname.includes('.')) {
    throw new Error('Destination hostname must be a fully-qualified public hostname.');
  }

  const port = normalizeDeliveryPort(parsedUrl);
  if (!config.security.exportDeliveryAllowedPorts.includes(port)) {
    throw new Error(`Destination port ${port} is not allowed for security export delivery.`);
  }

  return {
    url: parsedUrl,
    hostname,
    port,
    path: parsedUrl.pathname || '/'
  };
}

function describeDeliveryTargetPolicyError(reason: SecurityExportDeliveryTargetPolicyReason): string {
  switch (reason) {
    case 'policy_disabled':
      return 'Security export delivery is disabled by the tenant delivery policy.';
    case 'path_not_in_allowlist':
      return 'Destination path is not allowlisted in the tenant delivery policy.';
    case 'inherit_remote_policy_host_not_in_allowlist':
      return 'Destination host is not allowlisted in the inherited remote source policy.';
    case 'host_not_in_allowlist':
    default:
      return 'Destination host is not allowlisted in the tenant delivery policy.';
  }
}

function describeQuarantinedDestinationError(health: SecurityExportDeliveryDestinationHealth): string {
  if (health.active_incident) {
    const clearAfter = new Date(health.active_incident.clear_after).toISOString();
    const acknowledged = health.active_incident.acknowledged_at
      ? ` acknowledged by ${health.active_incident.acknowledged_by ?? 'an operator'}`
      : ' not yet acknowledged';
    if (Date.parse(health.active_incident.clear_after) > Date.now()) {
      return `Destination is quarantined by active incident ${health.active_incident.incident_id} until at least ${clearAfter}; it is${acknowledged} and must be manually cleared before delivery resumes.`;
    }

    return `Destination remains quarantined by active incident ${health.active_incident.incident_id}; cooldown ended at ${clearAfter} but it is${acknowledged} and still requires manual clear before delivery resumes.`;
  }

  const until = health.quarantined_until ? new Date(health.quarantined_until).toISOString() : 'unknown';
  return `Destination is temporarily quarantined due to recent failed or dead-letter security export deliveries until ${until}.`;
}

function getDeliveryDestinationHealth(tenantId: string, destination: DeliveryDestination, now = Date.now()): SecurityExportDeliveryDestinationHealth {
  const analytics = getDestinationAnalyticsForTenant(tenantId, {
    windowHours: config.security.exportDeliveryIncidentWindowHours,
    now
  }).find((entry) => destinationAnalyticsKey(entry.destination) === destinationAnalyticsKey(destination));

  return (
    analytics?.health ?? {
      verdict: 'healthy',
      total: 0,
      counts: buildStatusCounts(),
      terminal_failures: 0,
      dead_letters: 0,
      last_status: null,
      last_attempt_at: null,
      last_http_status: null,
      last_failure_code: null,
      last_failure_reason: null,
      quarantined_until: null,
      incident_window_hours: Math.max(1, config.security.exportDeliveryIncidentWindowHours),
      quarantine_duration_minutes: Math.max(1, config.security.exportDeliveryQuarantineDurationMinutes),
      quarantine_failure_threshold: Math.max(1, config.security.exportDeliveryQuarantineFailureThreshold),
      quarantine_dead_letter_threshold: Math.max(1, config.security.exportDeliveryQuarantineDeadLetterThreshold),
      active_incident: deliveryStore.getActiveIncidentByDestination(tenantId, destination)
        ? toIncidentSummary(deliveryStore.getActiveIncidentByDestination(tenantId, destination))
        : null
    }
  );
}

async function resolveDeliveryTarget(tenantId: string, destinationUrl: string, options: { allowQuarantined?: boolean } = {}): Promise<{
  url: URL;
  hostname: string;
  matchedHostRule: string;
  descriptor: DeliveryDestination;
  health: SecurityExportDeliveryDestinationHealth;
}> {
  const normalized = normalizeDeliveryTargetDestination(destinationUrl);
  const policyDecision = await evaluateSecurityExportDeliveryTargetPolicy({
    tenantId,
    hostname: normalized.hostname,
    port: normalized.port,
    path: normalized.path
  });

  if (!policyDecision.allowed || !policyDecision.matchedRule) {
    throw new Error(describeDeliveryTargetPolicyError(policyDecision.reason));
  }

  const descriptor = buildDeliveryDestination(normalized.url, policyDecision.matchedRule);
  const health = getDeliveryDestinationHealth(tenantId, descriptor);
  if (!options.allowQuarantined && health.verdict === 'quarantined') {
    throw new Error(describeQuarantinedDestinationError(health));
  }

  return {
    url: normalized.url,
    hostname: normalized.hostname,
    matchedHostRule: policyDecision.matchedRule,
    descriptor,
    health
  };
}

async function resolvePinnedAddress(hostname: string): Promise<{ address: string; family: number }> {
  const family = net.isIP(hostname);
  if (family > 0) {
    assertPublicRemoteAddress(hostname);
    return {
      address: hostname,
      family
    };
  }

  const resolved = await getLookup()(hostname);
  const [pinnedAddress] = normalizeLookupResult(hostname, resolved);
  return pinnedAddress;
}

export async function previewSecurityExportDeliveryTarget(options: {
  tenantId: string;
  destinationUrl: string;
  allowQuarantined?: boolean;
}): Promise<SecurityExportDeliveryTargetPreview> {
  const normalized = normalizeDeliveryTargetDestination(options.destinationUrl);
  const policyDecision = await evaluateSecurityExportDeliveryTargetPolicy({
    tenantId: options.tenantId,
    hostname: normalized.hostname,
    port: normalized.port,
    path: normalized.path
  });
  const destination = buildDeliveryDestination(normalized.url, policyDecision.matchedRule);
  const health = getDeliveryDestinationHealth(options.tenantId, destination);
  const pinnedAddress = await resolvePinnedAddress(normalized.hostname);
  const quarantined =
    !options.allowQuarantined && policyDecision.allowed && Boolean(policyDecision.matchedRule) && health.verdict === 'quarantined';

  return {
    allowed: policyDecision.allowed && !quarantined,
    reason: quarantined ? 'destination_quarantined' : policyDecision.reason,
    policy: policyDecision.policy,
    destination,
    matched_rule: policyDecision.matchedRule,
    pinned_address: pinnedAddress.address,
    pinned_address_family: pinnedAddress.family,
    health
  };
}

async function prepareSecurityExportDelivery(options: {
  tenantId: string;
  requestId?: string;
  destinationUrl: string;
  bundle: SecurityAuditExportBundle;
  allowQuarantined?: boolean;
}): Promise<{ prepared: PreparedDelivery; requestedAt: string }> {
  const requestedAt = new Date().toISOString();
  const target = await resolveDeliveryTarget(options.tenantId, options.destinationUrl, {
    allowQuarantined: options.allowQuarantined
  });
  await deliveryStore.rememberDestinationTarget(options.tenantId, target.descriptor, options.destinationUrl);
  const pinnedAddress = await resolvePinnedAddress(target.hostname);
  const deliveryId = crypto.randomUUID();
  const signedBundle = ensureSignedSecurityAuditExportBundle(options.bundle);
  const payload = JSON.stringify(signedBundle);
  const { headers, signature } = buildSignedHeaders(options.tenantId, deliveryId, target.url, payload, signedBundle);

  return {
    requestedAt,
    prepared: {
      deliveryId,
      target,
      payload,
      headers,
      pinnedAddress,
      signature
    }
  };
}

async function prepareSecurityExportDeliveryAttempt(options: {
  tenantId: string;
  deliveryId: string;
  destinationUrl: string;
  bundle: SecurityAuditExportBundle;
  payload: string;
  allowQuarantined?: boolean;
}): Promise<PreparedDelivery> {
  const target = await resolveDeliveryTarget(options.tenantId, options.destinationUrl, {
    allowQuarantined: options.allowQuarantined
  });
  await deliveryStore.rememberDestinationTarget(options.tenantId, target.descriptor, options.destinationUrl);
  const pinnedAddress = await resolvePinnedAddress(target.hostname);
  const signedBundle = ensureSignedSecurityAuditExportBundle(options.bundle);
  const payload = JSON.stringify(signedBundle);
  const { headers, signature } = buildSignedHeaders(options.tenantId, options.deliveryId, target.url, payload, signedBundle);

  return {
    deliveryId: options.deliveryId,
    target,
    payload,
    headers,
    pinnedAddress,
    signature
  };
}

function defaultTransport(prepared: PreparedDelivery): Promise<DeliveryTransportResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        protocol: 'https:',
        hostname: prepared.target.url.hostname,
        port: prepared.target.descriptor.port,
        path: `${prepared.target.url.pathname}${prepared.target.url.search}`,
        method: 'POST',
        timeout: config.security.exportDeliveryTimeoutMs,
        headers: {
          ...prepared.headers,
          'content-length': String(Buffer.byteLength(prepared.payload))
        },
        lookup: (_hostname, _options, callback) => {
          callback(null, prepared.pinnedAddress.address, prepared.pinnedAddress.family);
        }
      },
      (response) => {
        const buffers: Buffer[] = [];
        let totalBytes = 0;
        let truncated = false;

        response.on('data', (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (totalBytes < config.security.exportDeliveryMaxResponseBytes) {
            const remaining = config.security.exportDeliveryMaxResponseBytes - totalBytes;
            buffers.push(buffer.subarray(0, Math.max(0, remaining)));
          } else {
            truncated = true;
          }

          totalBytes += buffer.length;
          if (totalBytes > config.security.exportDeliveryMaxResponseBytes) {
            truncated = true;
          }
        });

        response.on('error', reject);
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            bodyText: Buffer.concat(buffers).toString('utf-8'),
            bodyTruncated: truncated,
            durationMs: Date.now() - startedAt,
            contentType: typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : undefined
          });
        });
      }
    );

    request.on('timeout', () => {
      request.destroy(new Error('Delivery request timed out.'));
    });

    request.on('error', reject);
    request.end(prepared.payload);
  });
}

async function dispatchSecurityExportDelivery(prepared: PreparedDelivery): Promise<DeliveryTransportResult> {
  if (transportForTests) {
    return transportForTests(prepared);
  }

  return defaultTransport(prepared);
}

function isRetryableHttpStatus(statusCode: number): boolean {
  return RETRYABLE_HTTP_STATUS_CODES.has(statusCode) || statusCode >= 500;
}

function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';

  if (RETRYABLE_ERROR_CODES.has(code)) {
    return true;
  }

  return /(timed out|timeout|socket hang up|temporar|tls handshake|network|dns|lookup|connect)/i.test(message);
}

function isBlockedMessage(message: string): boolean {
  return /allowlist|https|credential|invalid|disabled|hostname|port|public hostname|IP-literal|quarantined/i.test(message);
}

function inferFailureCode(message: string, blocked: boolean): 'policy_blocked' | 'destination_quarantined' | 'delivery_failed' {
  if (!blocked) {
    return 'delivery_failed';
  }

  return /quarantined/i.test(message) ? 'destination_quarantined' : 'policy_blocked';
}

function calculateRetryDelayMs(attemptCount: number): number {
  const base = Math.max(250, config.security.exportDeliveryRetryBaseDelayMs);
  const maxDelay = Math.max(base, config.security.exportDeliveryRetryMaxDelayMs);
  const exponential = Math.min(maxDelay, base * 2 ** Math.max(0, attemptCount - 1));
  const jitter = Math.floor(Math.random() * Math.min(1000, Math.max(100, exponential * 0.2)));
  return Math.min(maxDelay, exponential + jitter);
}

function recordSecurityEvent(
  type: SecurityAuditEventType,
  record: SecurityExportDeliveryRecord,
  extraDetails: Record<string, string | number | boolean | null> = {}
): void {
  securityAuditLog.record({
    tenant_id: record.tenant_id,
    type,
    request_id: record.request_id,
    details: {
      delivery_id: record.delivery_id,
      source_delivery_id: record.source_delivery_id ?? 'none',
      mode: record.mode,
      destination_host: record.destination.host,
      matched_host_rule: record.destination.matched_host_rule ?? 'none',
      http_status: record.http_status ?? 0,
      event_count: record.event_count,
      failure_code: record.failure_code ?? 'none',
      head_chain_hash: record.head_chain_hash ?? 'none',
      attempt_count: record.attempt_count,
      max_attempts: record.max_attempts,
      redrive_count: record.redrive_count,
      ...extraDetails
    }
  });
}

function createFallbackSignature(bundle: SecurityAuditExportBundle): SecurityExportDeliveryRecord['signature'] {
  return {
    algorithm: 'Ed25519',
    key_id: bundle.signature?.key_id ?? securityExportSigningRegistry.getActiveKeySummary().key_id,
    timestamp: new Date().toISOString(),
    nonce: crypto.randomUUID(),
    body_sha256: sha256Hex(JSON.stringify(bundle))
  };
}

function buildFallbackDestination(destinationUrl: string): DeliveryDestination {
  try {
    const url = new URL(String(destinationUrl ?? 'https://invalid.invalid/'));
    const hostname = normalizeRemoteHostname(url.hostname) || 'invalid';
    url.hostname = hostname;
    return buildDeliveryDestination(url, null);
  } catch {
    return {
      origin: 'invalid://invalid',
      host: 'invalid',
      port: 443,
      matched_host_rule: null,
      path_hint: '/',
      path_hash: crypto.createHash('sha256').update('/').digest('hex').slice(0, 16)
    };
  }
}

export async function deliverSecurityAuditExport(options: {
  tenantId: string;
  requestId?: string;
  destinationUrl: string;
  bundle: SecurityAuditExportBundle;
}): Promise<SecurityExportDeliveryRecord> {
  let requestedAt = new Date().toISOString();
  let prepared: PreparedDelivery | null = null;

  try {
    const preparedResult = await prepareSecurityExportDelivery(options);
    prepared = preparedResult.prepared;
    requestedAt = preparedResult.requestedAt;

    const result = await dispatchSecurityExportDelivery(prepared);
    const responseExcerpt = result.bodyText ? sanitizeString(result.bodyText, 220) : undefined;

    if (result.statusCode < 200 || result.statusCode >= 300) {
      const failedRecord = buildErrorRecord({
        tenantId: options.tenantId,
        requestId: options.requestId,
        deliveryId: prepared.deliveryId,
        mode: 'sync',
        requestedAt,
        completedAt: new Date().toISOString(),
        status: 'failed',
        destination: prepared.target.descriptor,
        bundle: options.bundle,
        signature: prepared.signature,
        attemptCount: 1,
        maxAttempts: 1,
        lastAttemptAt: requestedAt,
        failureCode: 'upstream_rejected',
        failureReason: `Destination responded with HTTP ${result.statusCode}.`,
        httpStatus: result.statusCode,
        durationMs: result.durationMs,
        responseExcerpt,
        responseExcerptTruncated: result.bodyTruncated,
        pinnedAddress: prepared.pinnedAddress.address,
        pinnedAddressFamily: prepared.pinnedAddress.family
      });
      await deliveryStore.upsert(failedRecord);
      recordSecurityEvent('security_export_delivery_failed', failedRecord);
      throw new SecurityExportDeliveryError('Security export delivery failed at the destination.', {
        code: 'upstream_rejected',
        statusCode: 502,
        record: failedRecord
      });
    }

    const successRecord = buildSuccessRecord({
      tenantId: options.tenantId,
      requestId: options.requestId,
      deliveryId: prepared.deliveryId,
      mode: 'sync',
      requestedAt,
      destination: prepared.target.descriptor,
      bundle: options.bundle,
      signature: prepared.signature,
      attemptCount: 1,
      maxAttempts: 1,
      lastAttemptAt: requestedAt,
      httpStatus: result.statusCode,
      durationMs: result.durationMs ?? 0,
      responseExcerpt,
      responseExcerptTruncated: result.bodyTruncated,
      pinnedAddress: prepared.pinnedAddress.address,
      pinnedAddressFamily: prepared.pinnedAddress.family
    });
    await deliveryStore.upsert(successRecord);
    recordSecurityEvent('security_export_delivered', successRecord);
    return successRecord;
  } catch (error) {
    if (error instanceof SecurityExportDeliveryError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : 'Security export delivery failed.';
    const blocked = isBlockedMessage(message);
    const failureCode = inferFailureCode(message, blocked);
    const deliveryId = prepared?.deliveryId ?? crypto.randomUUID();
    const signature = prepared?.signature ?? createFallbackSignature(options.bundle);
    const destination = prepared?.target.descriptor ?? buildFallbackDestination(options.destinationUrl);

    const record = buildErrorRecord({
      tenantId: options.tenantId,
      requestId: options.requestId,
      deliveryId,
      mode: 'sync',
      requestedAt,
      completedAt: new Date().toISOString(),
      status: blocked ? 'blocked' : 'failed',
      destination,
      bundle: options.bundle,
      signature,
      attemptCount: 1,
      maxAttempts: 1,
      lastAttemptAt: requestedAt,
      failureCode,
      failureReason: message,
      pinnedAddress: prepared?.pinnedAddress.address,
      pinnedAddressFamily: prepared?.pinnedAddress.family
    });

    await deliveryStore.upsert(record);
    recordSecurityEvent(blocked ? 'security_export_delivery_blocked' : 'security_export_delivery_failed', record);
    throw new SecurityExportDeliveryError(message, {
      code: failureCode,
      statusCode: blocked ? 403 : 502,
      record
    });
  }
}

export async function enqueueSecurityAuditExportDelivery(options: {
  tenantId: string;
  requestId?: string;
  destinationUrl: string;
  bundle: SecurityAuditExportBundle;
  idempotencyKey?: string;
}): Promise<EnqueueSecurityExportDeliveryResult> {
  const requestedAt = new Date().toISOString();
  const payload = JSON.stringify(options.bundle);
  const payloadSha256 = computeDeliveryIdempotencyPayloadHash(options.destinationUrl, options.bundle);
  const idempotencyTtlMs = Math.max(30, config.security.exportDeliveryIdempotencyTtlSeconds) * 1000;

  if (options.idempotencyKey) {
    const keyHash = sha256Base64Url(options.idempotencyKey);
    const existingEntry = deliveryStore.findIdempotency(options.tenantId, keyHash, idempotencyTtlMs);
    if (existingEntry) {
      if (existingEntry.payload_sha256 !== payloadSha256) {
        return { ok: false, reason: 'idempotency_conflict' };
      }

      const existingRecord = deliveryStore.get(options.tenantId, existingEntry.delivery_id);
      if (existingRecord) {
        return { ok: true, record: existingRecord, reused: true };
      }
    }
  }

  const activeDeliveries = deliveryStore.countActive(options.tenantId);
  if (activeDeliveries >= Math.max(1, config.security.exportDeliveryMaxActivePerTenant)) {
    return {
      ok: false,
      reason: 'active_limit_exceeded',
      activeDeliveries
    };
  }

  let target: Awaited<ReturnType<typeof resolveDeliveryTarget>>;
  try {
    target = await resolveDeliveryTarget(options.tenantId, options.destinationUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Security export delivery failed.';
    const blocked = isBlockedMessage(message);
    const failureCode = inferFailureCode(message, blocked);
    const record = buildErrorRecord({
      tenantId: options.tenantId,
      requestId: options.requestId,
      deliveryId: crypto.randomUUID(),
      mode: 'async',
      requestedAt,
      completedAt: new Date().toISOString(),
      status: blocked ? 'blocked' : 'failed',
      destination: buildFallbackDestination(options.destinationUrl),
      bundle: options.bundle,
      signature: createFallbackSignature(options.bundle),
      attemptCount: 0,
      maxAttempts: Math.max(1, config.security.exportDeliveryMaxAttempts),
      redriveCount: 0,
      failureCode,
      failureReason: message
    });

    await deliveryStore.upsert(record);
    recordSecurityEvent(blocked ? 'security_export_delivery_blocked' : 'security_export_delivery_failed', record);
    throw new SecurityExportDeliveryError(message, {
      code: failureCode,
      statusCode: blocked ? 403 : 400,
      record
    });
  }

  const deliveryId = crypto.randomUUID();
  const record = buildQueuedRecord({
    tenantId: options.tenantId,
    requestId: options.requestId,
    deliveryId,
    requestedAt,
    destination: target.descriptor,
    bundle: options.bundle,
    payload,
    maxAttempts: Math.max(1, config.security.exportDeliveryMaxAttempts)
  });

  await deliveryStore.upsert(record);
  await deliveryStore.setRetryMaterial(
    buildRetryMaterial({
      record,
      destinationUrl: options.destinationUrl,
      destination: target.descriptor,
      payload
    })
  );

  if (options.idempotencyKey) {
    await deliveryStore.rememberIdempotency({
      tenant_id: options.tenantId,
      delivery_id: deliveryId,
      key_hash: sha256Base64Url(options.idempotencyKey),
      payload_sha256: payloadSha256,
      created_at: requestedAt
    });
  }

  scheduleRetryProcessing();
  queueRetryProcessingSoon();

  return { ok: true, record, reused: false };
}

export async function redriveSecurityAuditExportDelivery(options: {
  tenantId: string;
  requestId?: string;
  deliveryId: string;
}): Promise<RedriveSecurityExportDeliveryResult> {
  const deliveryId = String(options.deliveryId ?? '').trim();
  if (!deliveryId) {
    throw new SecurityExportDeliveryError('Delivery ID is required for redrive.', {
      code: 'invalid_delivery_id',
      statusCode: 400,
      record: buildErrorRecord({
        tenantId: options.tenantId,
        requestId: options.requestId,
        deliveryId: crypto.randomUUID(),
        mode: 'async',
        requestedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: 'failed',
        destination: buildFallbackDestination('https://invalid.local'),
        bundle: {
          object: 'security_audit_export',
          tenant_id: options.tenantId,
          generated_at: new Date().toISOString(),
          filter: { limit: 0, truncated: false, total_matching_events: 0 },
          summary: securityAuditLog.summarize(options.tenantId),
          integrity: {
            verified: false,
            eventCount: 0,
            anchorPrevChainHash: null,
            headChainHash: null,
            lastSequence: null,
            firstEventId: null,
            lastEventId: null,
            failureReason: 'chain_hash_mismatch'
          },
          data: []
        },
        signature: createFallbackSignature({
          object: 'security_audit_export',
          tenant_id: options.tenantId,
          generated_at: new Date().toISOString(),
          filter: { limit: 0, truncated: false, total_matching_events: 0 },
          summary: securityAuditLog.summarize(options.tenantId),
          integrity: {
            verified: false,
            eventCount: 0,
            anchorPrevChainHash: null,
            headChainHash: null,
            lastSequence: null,
            firstEventId: null,
            lastEventId: null,
            failureReason: 'chain_hash_mismatch'
          },
          data: []
        }),
        attemptCount: 0,
        maxAttempts: Math.max(1, config.security.exportDeliveryMaxAttempts),
        failureCode: 'invalid_delivery_id',
        failureReason: 'Delivery ID is required for redrive.',
        redriveCount: 0
      })
    });
  }

  const existingRecord = deliveryStore.get(options.tenantId, deliveryId);
  if (!existingRecord) {
    throw new SecurityExportDeliveryError('Security export delivery was not found.', {
      code: 'delivery_not_found',
      statusCode: 404,
      record: buildErrorRecord({
        tenantId: options.tenantId,
        requestId: options.requestId,
        deliveryId,
        mode: 'async',
        requestedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: 'failed',
        destination: buildFallbackDestination('https://unknown.invalid'),
        bundle: {
          object: 'security_audit_export',
          tenant_id: options.tenantId,
          generated_at: new Date().toISOString(),
          filter: { limit: 0, truncated: false, total_matching_events: 0 },
          summary: securityAuditLog.summarize(options.tenantId),
          integrity: {
            verified: false,
            eventCount: 0,
            anchorPrevChainHash: null,
            headChainHash: null,
            lastSequence: null,
            firstEventId: null,
            lastEventId: null,
            failureReason: 'chain_hash_mismatch'
          },
          data: []
        },
        signature: createFallbackSignature({
          object: 'security_audit_export',
          tenant_id: options.tenantId,
          generated_at: new Date().toISOString(),
          filter: { limit: 0, truncated: false, total_matching_events: 0 },
          summary: securityAuditLog.summarize(options.tenantId),
          integrity: {
            verified: false,
            eventCount: 0,
            anchorPrevChainHash: null,
            headChainHash: null,
            lastSequence: null,
            firstEventId: null,
            lastEventId: null,
            failureReason: 'chain_hash_mismatch'
          },
          data: []
        }),
        attemptCount: 0,
        maxAttempts: Math.max(1, config.security.exportDeliveryMaxAttempts),
        failureCode: 'delivery_not_found',
        failureReason: 'Security export delivery was not found.',
        redriveCount: 0
      })
    });
  }

  if (existingRecord.status !== 'dead_letter') {
    throw new SecurityExportDeliveryError('Only dead-letter deliveries can be manually redriven.', {
      code: 'delivery_not_dead_letter',
      statusCode: 409,
      record: existingRecord
    });
  }

  const retryMaterial = deliveryStore.getRetryMaterial(existingRecord.delivery_id);
  if (!retryMaterial) {
    throw new SecurityExportDeliveryError('Retry material is unavailable for this dead-letter delivery.', {
      code: 'retry_material_missing',
      statusCode: 409,
      record: existingRecord
    });
  }

  assertRetryMaterialFingerprint(existingRecord, retryMaterial);

  const manualRedriveLimit = Math.max(1, config.security.exportDeliveryMaxManualRedrives);
  if ((retryMaterial.redrive_count ?? existingRecord.redrive_count ?? 0) >= manualRedriveLimit) {
    throw new SecurityExportDeliveryError('Manual redrive limit has been reached for this delivery.', {
      code: 'redrive_limit_exceeded',
      statusCode: 429,
      record: existingRecord
    });
  }

  const activeDeliveries = deliveryStore.countActive(options.tenantId);
  if (activeDeliveries >= Math.max(1, config.security.exportDeliveryMaxActivePerTenant)) {
    return {
      ok: false,
      reason: 'active_limit_exceeded',
      activeDeliveries
    };
  }

  let payload = '';
  let bundle: SecurityAuditExportBundle;
  try {
    payload = decryptString(retryMaterial.payload);
    bundle = JSON.parse(payload) as SecurityAuditExportBundle;
  } catch (error) {
    throw new SecurityExportDeliveryError(error instanceof Error ? error.message : 'Retry material cannot be decrypted.', {
      code: 'retry_material_corrupted',
      statusCode: 409,
      record: existingRecord
    });
  }

  try {
    await resolveDeliveryTarget(options.tenantId, retryMaterial.destination_url);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Security export delivery failed.';
    const blocked = isBlockedMessage(message);
    const failureCode = inferFailureCode(message, blocked);
    if (blocked) {
      recordSecurityEvent('security_export_delivery_blocked', existingRecord, {
        failure_code: failureCode,
        redrive_blocked: true
      });
    }
    throw new SecurityExportDeliveryError(message, {
      code: failureCode,
      statusCode: blocked ? 403 : 400,
      record: existingRecord
    });
  }

  const requestedAt = new Date().toISOString();
  const redriveCount = Math.max(retryMaterial.redrive_count ?? existingRecord.redrive_count ?? 0, existingRecord.redrive_count) + 1;
  const queuedRecord = buildQueuedRecord({
    tenantId: options.tenantId,
    requestId: options.requestId,
    deliveryId: crypto.randomUUID(),
    requestedAt,
    destination: existingRecord.destination,
    bundle,
    payload,
    maxAttempts: Math.max(1, config.security.exportDeliveryMaxAttempts),
    sourceDeliveryId: existingRecord.delivery_id,
    redriveCount
  });

  await deliveryStore.setRetryMaterial({
    ...retryMaterial,
    redrive_count: redriveCount,
    last_redriven_at: requestedAt
  });
  await deliveryStore.upsert(queuedRecord);
  await deliveryStore.setRetryMaterial(
    buildRetryMaterial({
      record: queuedRecord,
      destinationUrl: retryMaterial.destination_url,
      destination: existingRecord.destination,
      payload,
      lastRedrivenAt: requestedAt
    })
  );

  recordSecurityEvent('security_export_delivery_redriven', queuedRecord, {
    redriven_from_delivery_id: existingRecord.delivery_id,
    previous_dead_lettered_at: existingRecord.dead_lettered_at ?? null
  });

  scheduleRetryProcessing();
  queueRetryProcessingSoon();

  return { ok: true, record: queuedRecord };
}

async function processSingleRetryRecord(record: SecurityExportDeliveryRecord): Promise<void> {
  const retryMaterial = deliveryStore.getRetryMaterial(record.delivery_id);
  if (!retryMaterial) {
    const completedAt = new Date().toISOString();
    const deadRecord = buildErrorRecord({
      tenantId: record.tenant_id,
      requestId: record.request_id,
      deliveryId: record.delivery_id,
      sourceDeliveryId: record.source_delivery_id,
      mode: 'async',
      requestedAt: record.requested_at,
      updatedAt: completedAt,
      completedAt,
      status: 'dead_letter',
      destination: record.destination,
      bundle: {
        object: 'security_audit_export',
        tenant_id: record.tenant_id,
        generated_at: completedAt,
        filter: {
          limit: record.event_count,
          truncated: false,
          total_matching_events: record.event_count
        },
        summary: securityAuditLog.summarize(record.tenant_id),
        integrity: {
          verified: false,
          eventCount: 0,
          anchorPrevChainHash: null,
          headChainHash: record.head_chain_hash,
          lastSequence: null,
          firstEventId: null,
          lastEventId: null,
          failureReason: 'chain_hash_mismatch'
        },
        data: []
      },
      signature: record.signature,
      attemptCount: record.attempt_count,
      maxAttempts: record.max_attempts,
      redriveCount: record.redrive_count,
      lastAttemptAt: record.last_attempt_at,
      deadLetteredAt: completedAt,
      failureCode: 'retry_material_missing',
      failureReason: 'Retry material is unavailable for this delivery.'
    });
    await deliveryStore.upsert(deadRecord);
    recordSecurityEvent('security_export_delivery_dead_lettered', deadRecord, {
      reason: 'retry_material_missing'
    });
    return;
  }

  try {
    assertRetryMaterialFingerprint(record, retryMaterial);
  } catch (error) {
    const completedAt = new Date().toISOString();
    const deadRecord = buildErrorRecord({
      tenantId: record.tenant_id,
      requestId: record.request_id,
      deliveryId: record.delivery_id,
      sourceDeliveryId: record.source_delivery_id,
      mode: 'async',
      requestedAt: record.requested_at,
      updatedAt: completedAt,
      completedAt,
      status: 'dead_letter',
      destination: record.destination,
      bundle: {
        object: 'security_audit_export',
        tenant_id: record.tenant_id,
        generated_at: completedAt,
        filter: {
          limit: record.event_count,
          truncated: false,
          total_matching_events: record.event_count
        },
        summary: securityAuditLog.summarize(record.tenant_id),
        integrity: {
          verified: false,
          eventCount: 0,
          anchorPrevChainHash: null,
          headChainHash: record.head_chain_hash,
          lastSequence: null,
          firstEventId: null,
          lastEventId: null,
          failureReason: 'chain_hash_mismatch'
        },
        data: []
      },
      signature: record.signature,
      attemptCount: record.attempt_count,
      maxAttempts: record.max_attempts,
      redriveCount: record.redrive_count,
      lastAttemptAt: record.last_attempt_at,
      deadLetteredAt: completedAt,
      failureCode: 'retry_material_mismatch',
      failureReason: error instanceof Error ? error.message : 'Retry material fingerprint mismatch.'
    });
    await deliveryStore.deleteRetryMaterial(record.delivery_id);
    await deliveryStore.upsert(deadRecord);
    recordSecurityEvent('security_export_delivery_dead_lettered', deadRecord, {
      reason: 'retry_material_mismatch'
    });
    return;
  }

  let payload = '';
  let bundle: SecurityAuditExportBundle;
  try {
    payload = decryptString(retryMaterial.payload);
    bundle = JSON.parse(payload) as SecurityAuditExportBundle;
  } catch (error) {
    const completedAt = new Date().toISOString();
    const deadRecord = buildErrorRecord({
      tenantId: record.tenant_id,
      requestId: record.request_id,
      deliveryId: record.delivery_id,
      sourceDeliveryId: record.source_delivery_id,
      mode: 'async',
      requestedAt: record.requested_at,
      updatedAt: completedAt,
      completedAt,
      status: 'dead_letter',
      destination: record.destination,
      bundle: {
        object: 'security_audit_export',
        tenant_id: record.tenant_id,
        generated_at: completedAt,
        filter: {
          limit: record.event_count,
          truncated: false,
          total_matching_events: record.event_count
        },
        summary: securityAuditLog.summarize(record.tenant_id),
        integrity: {
          verified: false,
          eventCount: 0,
          anchorPrevChainHash: null,
          headChainHash: record.head_chain_hash,
          lastSequence: null,
          firstEventId: null,
          lastEventId: null,
          failureReason: 'chain_hash_mismatch'
        },
        data: []
      },
      signature: record.signature,
      attemptCount: record.attempt_count,
      maxAttempts: record.max_attempts,
      redriveCount: record.redrive_count,
      lastAttemptAt: record.last_attempt_at,
      deadLetteredAt: completedAt,
      failureCode: 'retry_material_corrupted',
      failureReason: error instanceof Error ? error.message : 'Retry material cannot be decrypted.'
    });
    await deliveryStore.deleteRetryMaterial(record.delivery_id);
    await deliveryStore.upsert(deadRecord);
    recordSecurityEvent('security_export_delivery_dead_lettered', deadRecord, {
      reason: 'retry_material_corrupted'
    });
    return;
  }

  const attemptCount = record.attempt_count + 1;
  const lastAttemptAt = new Date().toISOString();
  let prepared: PreparedDelivery | null = null;

  try {
    prepared = await prepareSecurityExportDeliveryAttempt({
      tenantId: record.tenant_id,
      deliveryId: record.delivery_id,
      destinationUrl: retryMaterial.destination_url,
      bundle,
      payload
    });

    const result = await dispatchSecurityExportDelivery(prepared);
    const responseExcerpt = result.bodyText ? sanitizeString(result.bodyText, 220) : undefined;

    if (result.statusCode >= 200 && result.statusCode < 300) {
      const successRecord = buildSuccessRecord({
        tenantId: record.tenant_id,
        requestId: record.request_id,
        deliveryId: record.delivery_id,
        sourceDeliveryId: record.source_delivery_id,
        mode: 'async',
        requestedAt: record.requested_at,
        destination: prepared.target.descriptor,
        bundle,
        signature: prepared.signature,
        attemptCount,
        maxAttempts: record.max_attempts,
        redriveCount: record.redrive_count,
        lastAttemptAt,
        httpStatus: result.statusCode,
        durationMs: result.durationMs ?? 0,
        responseExcerpt,
        responseExcerptTruncated: result.bodyTruncated,
        pinnedAddress: prepared.pinnedAddress.address,
        pinnedAddressFamily: prepared.pinnedAddress.family
      });
      await deliveryStore.deleteRetryMaterial(record.delivery_id);
      await deliveryStore.upsert(successRecord);
      recordSecurityEvent('security_export_delivered', successRecord);
      return;
    }

    const failureMessage = `Destination responded with HTTP ${result.statusCode}.`;
    if (attemptCount < record.max_attempts && isRetryableHttpStatus(result.statusCode)) {
      const nextAttemptAt = new Date(Date.now() + calculateRetryDelayMs(attemptCount)).toISOString();
      const retryRecord = buildErrorRecord({
        tenantId: record.tenant_id,
        requestId: record.request_id,
        deliveryId: record.delivery_id,
        sourceDeliveryId: record.source_delivery_id,
        mode: 'async',
        requestedAt: record.requested_at,
        status: 'retrying',
        destination: prepared.target.descriptor,
        bundle,
        signature: prepared.signature,
        attemptCount,
        maxAttempts: record.max_attempts,
        redriveCount: record.redrive_count,
        lastAttemptAt,
        nextAttemptAt,
        failureCode: 'upstream_rejected',
        failureReason: failureMessage,
        httpStatus: result.statusCode,
        durationMs: result.durationMs,
        responseExcerpt,
        responseExcerptTruncated: result.bodyTruncated,
        pinnedAddress: prepared.pinnedAddress.address,
        pinnedAddressFamily: prepared.pinnedAddress.family
      });
      await deliveryStore.upsert(retryRecord);
      recordSecurityEvent('security_export_delivery_failed', retryRecord, {
        retry_scheduled: true,
        next_attempt_at: nextAttemptAt
      });
      scheduleRetryProcessing();
      return;
    }

    const completedAt = new Date().toISOString();
    const terminalStatus: SecurityExportDeliveryStatus = isRetryableHttpStatus(result.statusCode) ? 'dead_letter' : 'failed';
    const terminalRecord = buildErrorRecord({
      tenantId: record.tenant_id,
      requestId: record.request_id,
      deliveryId: record.delivery_id,
      sourceDeliveryId: record.source_delivery_id,
      mode: 'async',
      requestedAt: record.requested_at,
      updatedAt: completedAt,
      completedAt,
      status: terminalStatus,
      destination: prepared.target.descriptor,
      bundle,
      signature: prepared.signature,
      attemptCount,
      maxAttempts: record.max_attempts,
      redriveCount: record.redrive_count,
      lastAttemptAt,
      deadLetteredAt: terminalStatus === 'dead_letter' ? completedAt : undefined,
      failureCode: 'upstream_rejected',
      failureReason: failureMessage,
      httpStatus: result.statusCode,
      durationMs: result.durationMs,
      responseExcerpt,
      responseExcerptTruncated: result.bodyTruncated,
      pinnedAddress: prepared.pinnedAddress.address,
      pinnedAddressFamily: prepared.pinnedAddress.family
    });
    if (terminalStatus !== 'dead_letter') {
      await deliveryStore.deleteRetryMaterial(record.delivery_id);
    }
    await deliveryStore.upsert(terminalRecord);
    recordSecurityEvent(
      terminalStatus === 'dead_letter' ? 'security_export_delivery_dead_lettered' : 'security_export_delivery_failed',
      terminalRecord
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Security export delivery failed.';
    const blocked = isBlockedMessage(message);
    const retryable = !blocked && isRetryableError(error);
    const failureCode = inferFailureCode(message, blocked);
    const destination = prepared?.target.descriptor ?? record.destination;
    const signature = prepared?.signature ?? record.signature;
    const pinnedAddress = prepared?.pinnedAddress.address;
    const pinnedAddressFamily = prepared?.pinnedAddress.family;

    if (retryable && attemptCount < record.max_attempts) {
      const nextAttemptAt = new Date(Date.now() + calculateRetryDelayMs(attemptCount)).toISOString();
      const retryRecord = buildErrorRecord({
        tenantId: record.tenant_id,
        requestId: record.request_id,
        deliveryId: record.delivery_id,
        sourceDeliveryId: record.source_delivery_id,
        mode: 'async',
        requestedAt: record.requested_at,
        status: 'retrying',
        destination,
        bundle,
        signature,
        attemptCount,
        maxAttempts: record.max_attempts,
        redriveCount: record.redrive_count,
        lastAttemptAt,
        nextAttemptAt,
        failureCode: 'delivery_failed',
        failureReason: message,
        pinnedAddress,
        pinnedAddressFamily
      });
      await deliveryStore.upsert(retryRecord);
      recordSecurityEvent('security_export_delivery_failed', retryRecord, {
        retry_scheduled: true,
        next_attempt_at: nextAttemptAt
      });
      scheduleRetryProcessing();
      return;
    }

    const completedAt = new Date().toISOString();
    const terminalStatus: SecurityExportDeliveryStatus = blocked ? 'blocked' : retryable ? 'dead_letter' : 'failed';
    const terminalRecord = buildErrorRecord({
      tenantId: record.tenant_id,
      requestId: record.request_id,
      deliveryId: record.delivery_id,
      sourceDeliveryId: record.source_delivery_id,
      mode: 'async',
      requestedAt: record.requested_at,
      updatedAt: completedAt,
      completedAt,
      status: terminalStatus as Extract<SecurityExportDeliveryStatus, 'failed' | 'blocked' | 'dead_letter'>,
      destination,
      bundle,
      signature,
      attemptCount,
      maxAttempts: record.max_attempts,
      redriveCount: record.redrive_count,
      lastAttemptAt,
      deadLetteredAt: terminalStatus === 'dead_letter' ? completedAt : undefined,
      failureCode: blocked ? failureCode : retryable ? 'delivery_failed' : 'delivery_failed',
      failureReason: message,
      pinnedAddress,
      pinnedAddressFamily
    });
    if (terminalStatus !== 'dead_letter') {
      await deliveryStore.deleteRetryMaterial(record.delivery_id);
    }
    await deliveryStore.upsert(terminalRecord);
    recordSecurityEvent(
      terminalStatus === 'blocked'
        ? 'security_export_delivery_blocked'
        : terminalStatus === 'dead_letter'
          ? 'security_export_delivery_dead_lettered'
          : 'security_export_delivery_failed',
      terminalRecord
    );
  }
}

async function processDueRetryQueue(options: { force?: boolean } = {}): Promise<number> {
  const dueRecords = deliveryStore.listDueRetryables(Date.now(), Boolean(options.force));
  let processed = 0;

  for (const record of dueRecords) {
    if (retryInFlight.has(record.delivery_id)) {
      continue;
    }

    retryInFlight.add(record.delivery_id);
    try {
      await processSingleRetryRecord(record);
      processed += 1;
    } finally {
      retryInFlight.delete(record.delivery_id);
    }
  }

  scheduleRetryProcessing();
  return processed;
}

function drainRetryQueue(options: { force?: boolean } = {}): Promise<number> {
  const step = retryChain
    .catch(() => undefined)
    .then(() => processDueRetryQueue(options));

  retryChain = step.then(
    () => undefined,
    () => undefined
  );

  return step;
}

export function listSecurityExportDeliveries(
  tenantId: string,
  opts: {
    limit?: number;
    status?: SecurityExportDeliveryStatus;
  } = {}
): SecurityExportDeliveryRecord[] {
  return deliveryStore.list(tenantId, opts);
}

export function listSecurityExportDeliveryIncidents(
  tenantId: string,
  opts: {
    limit?: number;
    status?: SecurityExportDeliveryIncidentStatus;
  } = {}
): SecurityExportDeliveryIncident[] {
  return deliveryStore.listIncidents(tenantId, opts);
}

export async function acknowledgeSecurityExportDeliveryIncident(options: {
  tenantId: string;
  incidentId: string;
  actor: string;
  note: string;
  expectedRevision?: number;
}): Promise<SecurityExportDeliveryIncident> {
  const incident = deliveryStore.getIncident(options.tenantId, options.incidentId);
  if (!incident || incident.status !== 'active') {
    throw new SecurityExportDeliveryIncidentError('Security export delivery incident not found.', {
      code: 'incident_not_found',
      statusCode: 404,
      incident
    });
  }

  if (
    Number.isFinite(options.expectedRevision) &&
    Number(options.expectedRevision) > 0 &&
    Number(options.expectedRevision) !== incident.revision
  ) {
    throw new SecurityExportDeliveryIncidentError('Security export delivery incident revision is stale. Refresh and retry.', {
      code: 'incident_revision_conflict',
      statusCode: 409,
      incident
    });
  }

  if (incident.acknowledged_at) {
    throw new SecurityExportDeliveryIncidentError('Security export delivery incident is already acknowledged.', {
      code: 'incident_already_acknowledged',
      statusCode: 409,
      incident
    });
  }

  const updated: SecurityExportDeliveryIncident = {
    ...incident,
    updated_at: new Date().toISOString(),
    acknowledged_at: new Date().toISOString(),
    acknowledged_by: sanitizeString(options.actor, 128),
    acknowledgment_note: sanitizeString(options.note, 280),
    revision: incident.revision + 1
  };

  await deliveryStore.saveIncident(updated);
  securityAuditLog.record({
    tenant_id: updated.tenant_id,
    type: 'security_export_delivery_incident_acknowledged',
    details: {
      incident_id: updated.incident_id,
      destination_host: updated.destination.host,
      path_hash: updated.destination.path_hash,
      actor: updated.acknowledged_by ?? 'unknown'
    }
  });
  return updated;
}

async function runSecurityExportDeliveryIncidentCanary(options: {
  tenantId: string;
  incident: SecurityExportDeliveryIncident;
  requestId?: string;
}): Promise<{ 
  matchedRule: string | null;
  pinnedAddress: string;
  pinnedAddressFamily: number;
  httpStatus: number;
  durationMs: number;
  responseExcerpt: string | null;
  responseExcerptTruncated: boolean;
}> {
  const destinationUrl = deliveryStore.getDestinationTargetUrl(options.tenantId, options.incident.destination);
  if (!destinationUrl) {
    throw new SecurityExportDeliveryIncidentError('Security export delivery incident target could not be recovered. Trigger a fresh delivery failure before requesting clear.', {
      code: 'incident_target_unavailable',
      statusCode: 409,
      incident: options.incident
    });
  }

  const bundle = ensureSignedSecurityAuditExportBundle(
    securityAuditLog.export(options.tenantId, {
      sinceTimestamp: Date.now() - Math.max(1, config.security.exportDeliveryIncidentWindowHours) * 60 * 60 * 1000,
      limit: 25,
      topIpLimit: 5
    })
  );

  try {
    const { prepared } = await prepareSecurityExportDelivery({
      tenantId: options.tenantId,
      requestId: options.requestId,
      destinationUrl,
      bundle,
      allowQuarantined: true
    });
    const result = await dispatchSecurityExportDelivery(prepared);
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new SecurityExportDeliveryIncidentError('Security export incident canary delivery failed. Keep destination quarantined until the target accepts a live canary again.', {
        code: 'incident_clear_canary_failed',
        statusCode: 502,
        incident: options.incident
      });
    }

    return {
      matchedRule: prepared.target.matchedHostRule,
      pinnedAddress: prepared.pinnedAddress.address,
      pinnedAddressFamily: prepared.pinnedAddress.family,
      httpStatus: result.statusCode,
      durationMs: result.durationMs ?? 0,
      responseExcerpt: result.bodyText ? sanitizeString(result.bodyText, 220) : null,
      responseExcerptTruncated: Boolean(result.bodyTruncated)
    };
  } catch (error) {
    if (error instanceof SecurityExportDeliveryIncidentError) {
      throw error;
    }

    if (error instanceof SecurityExportDeliveryError) {
      throw new SecurityExportDeliveryIncidentError(error.message, {
        code: error.code === 'destination_quarantined' ? 'incident_clear_canary_blocked' : 'incident_clear_canary_failed',
        statusCode: error.statusCode,
        incident: options.incident
      });
    }

    throw error;
  }
}

export async function requestSecurityExportDeliveryIncidentClear(options: {
  tenantId: string;
  incidentId: string;
  actor: string;
  note: string;
  expectedRevision?: number;
  requestId?: string;
}): Promise<SecurityExportDeliveryIncident> {
  const incident = deliveryStore.getIncident(options.tenantId, options.incidentId);
  if (!incident || incident.status !== 'active') {
    throw new SecurityExportDeliveryIncidentError('Security export delivery incident not found.', {
      code: 'incident_not_found',
      statusCode: 404,
      incident
    });
  }

  if (
    Number.isFinite(options.expectedRevision) &&
    Number(options.expectedRevision) > 0 &&
    Number(options.expectedRevision) !== incident.revision
  ) {
    throw new SecurityExportDeliveryIncidentError('Security export delivery incident revision is stale. Refresh and retry.', {
      code: 'incident_revision_conflict',
      statusCode: 409,
      incident
    });
  }

  if (!incident.acknowledged_at) {
    throw new SecurityExportDeliveryIncidentError('Security export delivery incident must be acknowledged before a clear request can be created.', {
      code: 'incident_ack_required',
      statusCode: 409,
      incident
    });
  }

  const clearAfterMs = Date.parse(incident.clear_after);
  if (!Number.isFinite(clearAfterMs) || clearAfterMs > Date.now()) {
    throw new SecurityExportDeliveryIncidentError('Security export delivery incident cooldown is still active. Wait until clear_after before requesting clear.', {
      code: 'incident_cooldown_active',
      statusCode: 409,
      incident
    });
  }

  if (incident.clear_request && !incident.clear_request.consumed_at && Date.parse(incident.clear_request.expires_at) > Date.now()) {
    throw new SecurityExportDeliveryIncidentError('Security export delivery incident already has a pending clear request awaiting second-operator approval.', {
      code: 'incident_clear_request_pending',
      statusCode: 409,
      incident
    });
  }

  const canary = await runSecurityExportDeliveryIncidentCanary({
    tenantId: options.tenantId,
    incident,
    requestId: options.requestId
  });
  const nowIso = new Date().toISOString();
  const updated: SecurityExportDeliveryIncident = {
    ...incident,
    updated_at: nowIso,
    clear_request: {
      request_id: crypto.randomUUID(),
      requested_at: nowIso,
      requested_by: sanitizeString(options.actor, 128),
      note: sanitizeString(options.note, 280),
      expires_at: new Date(Date.now() + Math.max(1, Math.trunc(config.security.exportDeliveryClearRequestTtlMinutes)) * 60 * 1000).toISOString(),
      canary_checked_at: nowIso,
      canary_http_status: canary.httpStatus,
      canary_duration_ms: canary.durationMs,
      canary_response_excerpt: canary.responseExcerpt,
      canary_response_excerpt_truncated: canary.responseExcerptTruncated,
      canary_pinned_address: canary.pinnedAddress,
      canary_pinned_address_family: canary.pinnedAddressFamily,
      canary_matched_rule: canary.matchedRule,
      consumed_at: null,
      consumed_by: null,
      approval_note: null
    },
    revision: incident.revision + 1
  };

  await deliveryStore.saveIncident(updated);
  securityAuditLog.record({
    tenant_id: updated.tenant_id,
    type: 'security_export_delivery_incident_clear_requested',
    details: {
      incident_id: updated.incident_id,
      request_id: updated.clear_request?.request_id ?? null,
      destination_host: updated.destination.host,
      path_hash: updated.destination.path_hash,
      actor: updated.clear_request?.requested_by ?? 'unknown',
      canary_http_status: updated.clear_request?.canary_http_status ?? 0,
      expires_at: updated.clear_request?.expires_at ?? nowIso
    }
  });
  return updated;
}

export async function clearSecurityExportDeliveryIncident(options: {
  tenantId: string;
  incidentId: string;
  actor: string;
  note: string;
  expectedRevision?: number;
}): Promise<SecurityExportDeliveryIncident> {
  const incident = deliveryStore.getIncident(options.tenantId, options.incidentId);
  if (!incident || incident.status !== 'active') {
    throw new SecurityExportDeliveryIncidentError('Security export delivery incident not found.', {
      code: 'incident_not_found',
      statusCode: 404,
      incident
    });
  }

  if (
    Number.isFinite(options.expectedRevision) &&
    Number(options.expectedRevision) > 0 &&
    Number(options.expectedRevision) !== incident.revision
  ) {
    throw new SecurityExportDeliveryIncidentError('Security export delivery incident revision is stale. Refresh and retry.', {
      code: 'incident_revision_conflict',
      statusCode: 409,
      incident
    });
  }

  if (!incident.acknowledged_at) {
    throw new SecurityExportDeliveryIncidentError('Security export delivery incident must be acknowledged before it can be cleared.', {
      code: 'incident_ack_required',
      statusCode: 409,
      incident
    });
  }

  if (!incident.clear_request || incident.clear_request.consumed_at) {
    throw new SecurityExportDeliveryIncidentError('Security export delivery incident requires a successful clear request and live canary before it can be cleared.', {
      code: 'incident_clear_request_required',
      statusCode: 409,
      incident
    });
  }

  const clearAfterMs = Date.parse(incident.clear_after);
  if (!Number.isFinite(clearAfterMs) || clearAfterMs > Date.now()) {
    throw new SecurityExportDeliveryIncidentError('Security export delivery incident cooldown is still active. Wait until clear_after before clearing it.', {
      code: 'incident_cooldown_active',
      statusCode: 409,
      incident
    });
  }

  const clearRequestExpiryMs = Date.parse(incident.clear_request.expires_at);
  if (!Number.isFinite(clearRequestExpiryMs) || clearRequestExpiryMs <= Date.now()) {
    throw new SecurityExportDeliveryIncidentError('Security export delivery incident clear request expired. Run a fresh canary before attempting clear again.', {
      code: 'incident_clear_request_expired',
      statusCode: 409,
      incident
    });
  }

  if (sanitizeString(options.actor, 128) === incident.clear_request.requested_by) {
    throw new SecurityExportDeliveryIncidentError('Security export delivery incident clear requires a second operator. The requester cannot approve and clear their own request.', {
      code: 'incident_clear_request_second_operator_required',
      statusCode: 409,
      incident
    });
  }

  const destinationUrl = deliveryStore.getDestinationTargetUrl(options.tenantId, incident.destination);
  if (!destinationUrl) {
    throw new SecurityExportDeliveryIncidentError('Security export delivery incident target could not be recovered. Trigger a fresh delivery failure before requesting clear.', {
      code: 'incident_target_unavailable',
      statusCode: 409,
      incident
    });
  }

  const preview = await previewSecurityExportDeliveryTarget({
    tenantId: options.tenantId,
    destinationUrl,
    allowQuarantined: true
  });
  if (!preview.allowed || preview.matched_rule !== incident.clear_request.canary_matched_rule) {
    throw new SecurityExportDeliveryIncidentError('Security export delivery incident clear request is stale against the current delivery policy. Run a fresh canary before clearing.', {
      code: 'incident_clear_request_stale',
      statusCode: 409,
      incident
    });
  }

  const nowIso = new Date().toISOString();
  const updated: SecurityExportDeliveryIncident = {
    ...incident,
    status: 'resolved',
    updated_at: nowIso,
    resolved_at: nowIso,
    cleared_at: nowIso,
    cleared_by: sanitizeString(options.actor, 128),
    clear_note: sanitizeString(options.note, 280),
    clear_request: {
      ...incident.clear_request,
      consumed_at: nowIso,
      consumed_by: sanitizeString(options.actor, 128),
      approval_note: sanitizeString(options.note, 280)
    },
    revision: incident.revision + 1
  };

  await deliveryStore.saveIncident(updated);
  securityAuditLog.record({
    tenant_id: updated.tenant_id,
    type: 'security_export_delivery_incident_cleared',
    details: {
      incident_id: updated.incident_id,
      request_id: updated.clear_request?.request_id ?? null,
      destination_host: updated.destination.host,
      path_hash: updated.destination.path_hash,
      actor: updated.cleared_by ?? 'unknown'
    }
  });
  return updated;
}

export function getSecurityExportDeliveryAnalytics(
  tenantId: string,
  options: {
    windowHours?: number;
    bucketHours?: number;
    destinationLimit?: number;
  } = {}
): SecurityExportDeliveryAnalytics {
  const now = Date.now();
  const windowHours = Math.max(1, Math.trunc(options.windowHours ?? config.security.exportDeliveryIncidentWindowHours));
  const bucketHours = Math.max(1, Math.min(windowHours, Math.trunc(options.bucketHours ?? 6)));
  const destinationLimit = Math.max(1, Math.trunc(options.destinationLimit ?? 10));
  const allRecords = deliveryStore.listAll(tenantId);
  const windowStartMs = now - windowHours * 60 * 60 * 1000;
  const records = allRecords.filter((record) => {
    const timestamp = recordTimelineTimestamp(record);
    return Number.isFinite(timestamp) && timestamp >= windowStartMs;
  });

  const counts = buildStatusCounts();
  for (const record of records) {
    counts[record.status] += 1;
  }

  const terminalCount = counts.succeeded + counts.failed + counts.blocked + counts.dead_letter;
  const successRate = terminalCount > 0 ? Number((counts.succeeded / terminalCount).toFixed(4)) : 1;
  const destinations = getDestinationAnalyticsForTenant(tenantId, { windowHours, now });
  const activeIncidents = deliveryStore.listIncidents(tenantId, { status: 'active', limit: config.security.exportDeliveryMaxRecordsPerTenant });
  const clearableIncidents = activeIncidents.filter((incident) => Date.parse(incident.clear_after) <= now);

  const bucketMs = bucketHours * 60 * 60 * 1000;
  const bucketStartMs = now - windowHours * 60 * 60 * 1000;
  const bucketCount = Math.max(1, Math.ceil((now - bucketStartMs) / bucketMs));
  const timeline = Array.from({ length: bucketCount }, (_, index) => {
    const startedAtMs = bucketStartMs + index * bucketMs;
    const endedAtMs = Math.min(now, startedAtMs + bucketMs);
    return {
      started_at: new Date(startedAtMs).toISOString(),
      ended_at: new Date(endedAtMs).toISOString(),
      total: 0,
      counts: buildStatusCounts()
    };
  });

  for (const record of records) {
    const timestamp = recordTimelineTimestamp(record);
    if (!Number.isFinite(timestamp) || timestamp < bucketStartMs) {
      continue;
    }

    const bucketIndex = Math.min(timeline.length - 1, Math.floor((timestamp - bucketStartMs) / bucketMs));
    const bucket = timeline[bucketIndex];
    if (!bucket) {
      continue;
    }

    bucket.total += 1;
    bucket.counts[record.status] += 1;
  }

  return {
    generated_at: new Date(now).toISOString(),
    window: {
      hours: windowHours,
      bucket_hours: bucketHours,
      started_at: new Date(bucketStartMs).toISOString(),
      ended_at: new Date(now).toISOString()
    },
    summary: {
      total_records: records.length,
      active_queue_count: allRecords.filter((record) => record.status === 'queued' || record.status === 'retrying').length,
      active_destinations: destinations.length,
      quarantined_destinations: destinations.filter((entry) => entry.health.verdict === 'quarantined').length,
      degraded_destinations: destinations.filter((entry) => entry.health.verdict === 'degraded').length,
      active_incidents: activeIncidents.length,
      unacknowledged_incidents: activeIncidents.filter((incident) => !incident.acknowledged_at).length,
      clearable_incidents: clearableIncidents.length,
      success_rate: successRate,
      counts
    },
    incidents: destinations.filter((entry) => entry.health.verdict !== 'healthy').slice(0, destinationLimit),
    destinations: destinations.slice(0, destinationLimit),
    timeline
  };
}

export const __private__ = {
  prepareSecurityExportDelivery,
  async processRetryQueueForTests(options: { force?: boolean } = {}) {
    return processDueRetryQueue(options);
  },
  resetStoreForTests() {
    clearRetryTimer();
    deliveryStore.reset();
    retryInFlight.clear();
    retryChain = Promise.resolve();
  },
  setLookupForTests(lookup?: (hostname: string) => Promise<LookupResult>) {
    lookupForTests = lookup;
  },
  setTransportForTests(transport?: (prepared: PreparedDelivery) => Promise<DeliveryTransportResult>) {
    transportForTests = transport;
  },
  setAutoProcessForTests(enabled = true) {
    autoProcessEnabled = enabled;
    if (!enabled) {
      clearRetryTimer();
      return;
    }

    scheduleRetryProcessing();
  }
};

export { SecurityExportDeliveryError, SecurityExportDeliveryIncidentError };
