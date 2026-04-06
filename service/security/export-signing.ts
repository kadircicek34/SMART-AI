import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { readJsonFileSync, writeJsonFileAtomicSync } from '../persistence/json-file.js';
import type { SecurityAuditExportBundle } from './audit-log.js';

const SIGNING_STORE_VERSION = 3;
const SECURITY_EXPORT_JWKS_PATH = '/.well-known/smart-ai/security-export-keys.json';
const SUPPORTED_EXPORT_SIGNATURE_ALGORITHM = 'Ed25519' as const;
const SUPPORTED_EXPORT_SIGNATURE_ALG_HEADER = 'EdDSA' as const;
const MIN_POLICY_HOURS = 1 / 3600;
const MAX_POLICY_HOURS = 24 * 365 * 5;
const DEFAULT_MUTEX_WAIT_MS = 750;
const DEFAULT_MUTEX_POLL_MS = 20;

const SLEEP_BUFFER = new SharedArrayBuffer(4);
const SLEEP_VIEW = new Int32Array(SLEEP_BUFFER);

type SecurityExportSigningLifecycleAlert =
  | 'active_key_rotation_due'
  | 'active_key_expiring_soon'
  | 'active_key_expired'
  | 'verify_only_key_retention_due';

type SecurityExportSigningMaintenanceTrigger = 'startup' | 'timer' | 'request' | 'admin';

type SecurityExportSigningMaintenanceAction =
  | 'bootstrap_active_key'
  | 'normalize_active_key'
  | 'rotate_due_active_key'
  | 'rotate_expired_active_key'
  | 'prune_verify_only_keys';

export type SecurityExportSignatureAlgorithm = typeof SUPPORTED_EXPORT_SIGNATURE_ALGORITHM;
export type SecurityExportSignatureAlgHeader = typeof SUPPORTED_EXPORT_SIGNATURE_ALG_HEADER;
export type SecurityExportSigningKeyStatus = 'active' | 'verify_only';

export type SecurityExportOkpJwk = {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  use: 'sig';
  alg: 'EdDSA';
};

type SecurityExportPrivateJwk = SecurityExportOkpJwk & {
  d: string;
};

type EncryptedValue = {
  iv: string;
  tag: string;
  data: string;
};

type SecurityExportSigningKeyRecord = {
  key_id: string;
  algorithm: SecurityExportSignatureAlgorithm;
  status: SecurityExportSigningKeyStatus;
  created_at: string;
  activated_at: string;
  deactivated_at?: string;
  fingerprint: string;
  public_jwk: SecurityExportOkpJwk;
  private_jwk: EncryptedValue;
};

type SecurityExportSigningLeaseState = {
  holder_id: string;
  token: string;
  acquired_at: string;
  updated_at: string;
  expires_at: string;
};

type SecurityExportSigningStoreSnapshot = {
  version: number;
  updatedAt: string;
  revision?: unknown;
  policy?: unknown;
  lease?: unknown;
  maintenance?: unknown;
  keys: unknown[];
};

export type SecurityExportSigningLifecyclePolicy = {
  auto_rotate: boolean;
  rotate_after_hours: number;
  expire_after_hours: number;
  warn_before_hours: number;
  verify_retention_hours: number;
};

export type SecurityExportSigningKeyLifecycle = {
  age_hours: number;
  rotation_due_at?: string;
  expires_at?: string;
  retained_until?: string;
  rotation_due: boolean;
  expiring_soon: boolean;
  expired: boolean;
  retention_expired: boolean;
};

export type SecurityExportSignature = {
  algorithm: SecurityExportSignatureAlgorithm;
  key_id: string;
  signed_at: string;
  payload_sha256: string;
  signature: string;
  public_keys_url: string;
};

export type SecurityExportSignatureVerification = {
  verified: boolean;
  algorithm: SecurityExportSignatureAlgorithm;
  key_id: string | null;
  payload_sha256: string | null;
  public_keys_url: string;
  reason?: 'signature_missing' | 'unsupported_algorithm' | 'unknown_key' | 'payload_sha256_mismatch' | 'signature_invalid';
};

export type SecurityExportSigningKeySummary = {
  key_id: string;
  algorithm: SecurityExportSignatureAlgorithm;
  status: SecurityExportSigningKeyStatus;
  created_at: string;
  activated_at: string;
  deactivated_at?: string;
  fingerprint: string;
  public_jwk: SecurityExportOkpJwk;
  lifecycle: SecurityExportSigningKeyLifecycle;
};

export type SecurityExportPublicJwks = {
  object: 'jwks';
  generated_at: string;
  active_key_id: string;
  keys: SecurityExportOkpJwk[];
};

export type SecurityExportSigningMaintenanceRunSummary = {
  run_id: string;
  trigger: SecurityExportSigningMaintenanceTrigger;
  dry_run: boolean;
  started_at: string;
  completed_at: string;
  changed: boolean;
  actions: SecurityExportSigningMaintenanceAction[];
  rotation_performed: boolean;
  pruned_verify_only_keys: number;
  active_key_id_before: string | null;
  active_key_id_after: string | null;
  key_count_before: number;
  key_count_after: number;
  lease: {
    holder_id: string | null;
    expires_at: string | null;
    is_holder: boolean;
    acquired: boolean;
  };
  skipped_reason?: 'no_changes_required' | 'lease_held_by_other' | 'dry_run' | 'mutex_unavailable';
};

export type SecurityExportSigningMaintenanceState = {
  object: 'security_export_signing_maintenance';
  generated_at: string;
  instance_id: string;
  revision: number;
  updated_at: string | null;
  maintenance_interval_minutes: number | null;
  lease_ttl_seconds: number;
  leader: {
    holder_id: string | null;
    expires_at: string | null;
    is_holder: boolean;
    active: boolean;
  };
  last_run: SecurityExportSigningMaintenanceRunSummary | null;
  history: SecurityExportSigningMaintenanceRunSummary[];
};

export type SecurityExportSigningLifecycleState = {
  object: 'security_export_signing_lifecycle';
  generated_at: string;
  public_keys_url: string;
  maintenance_interval_minutes: number | null;
  active_key_id: string;
  status: 'healthy' | 'warning' | 'rotation_due' | 'expired';
  alerts: SecurityExportSigningLifecycleAlert[];
  policy: SecurityExportSigningLifecyclePolicy;
  active_key: SecurityExportSigningKeySummary;
  verify_only: {
    total: number;
    prunable: number;
    oldest_deactivated_at: string | null;
    next_prune_at: string | null;
  };
};

type SecurityExportSigningResult = {
  algorithm: SecurityExportSignatureAlgorithm;
  key_id: string;
  signature: string;
  signed_at: string;
};

type SecurityExportSigningRegistryOptions = {
  filePath: string;
  masterKey: Buffer;
  maxVerifyKeys?: number;
  defaultPolicy?: SecurityExportSigningLifecyclePolicy;
  maintenanceIntervalMs?: number;
  maintenanceLeaseTtlMs?: number;
  maintenanceHistoryLimit?: number;
};

type SecurityExportSigningMaintenancePreview = {
  nextKeys: SecurityExportSigningKeyRecord[];
  changed: boolean;
  actions: SecurityExportSigningMaintenanceAction[];
  rotationPerformed: boolean;
  prunedVerifyOnlyKeys: number;
  activeKeyIdBefore: string | null;
  activeKeyIdAfter: string | null;
  keyCountBefore: number;
  keyCountAfter: number;
};

export class SecurityExportSigningError extends Error {
  readonly code: 'active_key_unavailable' | 'active_key_expired' | 'store_busy';
  readonly statusCode: number;

  constructor(message: string, code: 'active_key_unavailable' | 'active_key_expired' | 'store_busy') {
    super(message);
    this.name = 'SecurityExportSigningError';
    this.code = code;
    this.statusCode = code === 'store_busy' ? 409 : 503;
  }
}

function clampHours(value: number): number {
  return Math.min(MAX_POLICY_HOURS, Math.max(MIN_POLICY_HOURS, value));
}

function normalizeHours(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return clampHours(fallback);
  }

  return clampHours(parsed);
}

function hoursToMs(value: number): number {
  return Math.max(1, Math.round(clampHours(value) * 60 * 60 * 1000));
}

function roundHours(valueMs: number): number {
  return Number(Math.max(0, valueMs / (60 * 60 * 1000)).toFixed(3));
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function computeFingerprint(jwk: Pick<SecurityExportOkpJwk, 'kty' | 'crv' | 'x'>): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }))
    .digest('base64url');
}

function buildPublicJwk(keyId: string, publicKey: crypto.KeyObject): SecurityExportOkpJwk {
  const exported = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  if (exported.kty !== 'OKP' || exported.crv !== 'Ed25519' || !exported.x) {
    throw new Error('Unexpected public JWK generated for security export signing key.');
  }

  return {
    kty: 'OKP',
    crv: 'Ed25519',
    x: exported.x,
    kid: keyId,
    use: 'sig',
    alg: SUPPORTED_EXPORT_SIGNATURE_ALG_HEADER
  };
}

function buildPrivateJwk(keyId: string, privateKey: crypto.KeyObject): SecurityExportPrivateJwk {
  const exported = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  if (exported.kty !== 'OKP' || exported.crv !== 'Ed25519' || !exported.x || !exported.d) {
    throw new Error('Unexpected private JWK generated for security export signing key.');
  }

  return {
    kty: 'OKP',
    crv: 'Ed25519',
    x: exported.x,
    d: exported.d,
    kid: keyId,
    use: 'sig',
    alg: SUPPORTED_EXPORT_SIGNATURE_ALG_HEADER
  };
}

function createPrivateKeyFromJwk(jwk: SecurityExportPrivateJwk): crypto.KeyObject {
  return crypto.createPrivateKey({ key: jwk, format: 'jwk' });
}

function createPublicKeyFromJwk(jwk: SecurityExportOkpJwk): crypto.KeyObject {
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

function encryptJson(masterKey: Buffer, payload: unknown): EncryptedValue {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const plain = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64')
  };
}

function decryptJson<T>(masterKey: Buffer, encrypted: EncryptedValue): T {
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(plain) as T;
}

function sanitizeIsoTimestamp(value: unknown, fallback = Date.now()): string {
  const parsed = Date.parse(String(value ?? fallback));
  return new Date(Number.isFinite(parsed) ? parsed : fallback).toISOString();
}

function isEncryptedValue(value: unknown): value is EncryptedValue {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<EncryptedValue>;
  return Boolean(candidate.iv && candidate.tag && candidate.data);
}

function normalizeLifecyclePolicy(
  value: unknown,
  fallback: SecurityExportSigningLifecyclePolicy
): SecurityExportSigningLifecyclePolicy {
  const candidate = value && typeof value === 'object' ? (value as Partial<SecurityExportSigningLifecyclePolicy>) : {};
  const rotateAfter = normalizeHours(candidate.rotate_after_hours, fallback.rotate_after_hours);
  const minimumGapHours = MIN_POLICY_HOURS;
  const expireAfter = Math.max(
    rotateAfter + minimumGapHours,
    normalizeHours(candidate.expire_after_hours, fallback.expire_after_hours)
  );
  const warnBefore = Math.min(
    expireAfter,
    normalizeHours(candidate.warn_before_hours, Math.min(fallback.warn_before_hours, expireAfter))
  );
  const verifyRetention = normalizeHours(candidate.verify_retention_hours, fallback.verify_retention_hours);

  return {
    auto_rotate: candidate.auto_rotate === undefined ? fallback.auto_rotate : candidate.auto_rotate !== false,
    rotate_after_hours: rotateAfter,
    expire_after_hours: expireAfter,
    warn_before_hours: warnBefore,
    verify_retention_hours: verifyRetention
  };
}

function sanitizeStoredKey(value: unknown): SecurityExportSigningKeyRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<SecurityExportSigningKeyRecord>;
  const publicJwk = candidate.public_jwk as Partial<SecurityExportOkpJwk> | undefined;
  if (
    !candidate.key_id ||
    candidate.algorithm !== SUPPORTED_EXPORT_SIGNATURE_ALGORITHM ||
    (candidate.status !== 'active' && candidate.status !== 'verify_only') ||
    !publicJwk ||
    publicJwk.kty !== 'OKP' ||
    publicJwk.crv !== 'Ed25519' ||
    !publicJwk.x ||
    !publicJwk.kid ||
    !isEncryptedValue(candidate.private_jwk)
  ) {
    return null;
  }

  return {
    key_id: String(candidate.key_id).trim(),
    algorithm: SUPPORTED_EXPORT_SIGNATURE_ALGORITHM,
    status: candidate.status,
    created_at: sanitizeIsoTimestamp(candidate.created_at),
    activated_at: sanitizeIsoTimestamp(candidate.activated_at),
    deactivated_at: candidate.deactivated_at ? sanitizeIsoTimestamp(candidate.deactivated_at) : undefined,
    fingerprint: String(
      candidate.fingerprint ??
        computeFingerprint({
          kty: 'OKP',
          crv: 'Ed25519',
          x: String(publicJwk.x)
        })
    ).trim(),
    public_jwk: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: String(publicJwk.x),
      kid: String(publicJwk.kid),
      use: 'sig',
      alg: 'EdDSA'
    },
    private_jwk: candidate.private_jwk
  };
}

function canonicalizeJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Cannot canonicalize non-finite number values.');
    }
    return JSON.stringify(value);
  }

  if (typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));

    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalizeJson(entryValue)}`).join(',')}}`;
  }

  throw new Error(`Unsupported JSON value for canonicalization: ${typeof value}`);
}

function stripBundleSignature(bundle: SecurityAuditExportBundle): Omit<SecurityAuditExportBundle, 'signature'> {
  const { signature: _signature, ...unsignedBundle } = bundle;
  return unsignedBundle;
}

function buildCanonicalBundlePayload(bundle: SecurityAuditExportBundle): string {
  return canonicalizeJson(stripBundleSignature(bundle));
}

function buildSignatureMetadata(signing: SecurityExportSigningResult, canonicalPayload: string): SecurityExportSignature {
  return {
    algorithm: signing.algorithm,
    key_id: signing.key_id,
    signed_at: signing.signed_at,
    payload_sha256: sha256Hex(canonicalPayload),
    signature: signing.signature,
    public_keys_url: SECURITY_EXPORT_JWKS_PATH
  };
}

function safeDateMs(value: unknown): number {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function sleepSync(ms: number): void {
  if (ms <= 0) {
    return;
  }

  Atomics.wait(SLEEP_VIEW, 0, 0, ms);
}

function statMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function sanitizePositiveInteger(value: unknown, fallback: number, min = 1): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }

  return Math.max(min, Math.trunc(parsed));
}

function sanitizeLeaseState(value: unknown): SecurityExportSigningLeaseState | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<SecurityExportSigningLeaseState>;
  const holderId = String(candidate.holder_id ?? '').trim();
  const token = String(candidate.token ?? '').trim();
  if (!holderId || !token) {
    return null;
  }

  return {
    holder_id: holderId,
    token,
    acquired_at: sanitizeIsoTimestamp(candidate.acquired_at),
    updated_at: sanitizeIsoTimestamp(candidate.updated_at),
    expires_at: sanitizeIsoTimestamp(candidate.expires_at)
  };
}

function sanitizeMaintenanceRunSummary(value: unknown): SecurityExportSigningMaintenanceRunSummary | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<SecurityExportSigningMaintenanceRunSummary>;
  const trigger = String(candidate.trigger ?? '').trim() as SecurityExportSigningMaintenanceTrigger;
  if (!['startup', 'timer', 'request', 'admin'].includes(trigger)) {
    return null;
  }

  const actions = Array.isArray(candidate.actions)
    ? candidate.actions.filter((entry): entry is SecurityExportSigningMaintenanceAction =>
        [
          'bootstrap_active_key',
          'normalize_active_key',
          'rotate_due_active_key',
          'rotate_expired_active_key',
          'prune_verify_only_keys'
        ].includes(String(entry))
      )
    : [];

  const leaseCandidate = candidate.lease && typeof candidate.lease === 'object' ? candidate.lease : {};
  const skippedReason = String(candidate.skipped_reason ?? '').trim();
  const allowedSkippedReasons = ['no_changes_required', 'lease_held_by_other', 'dry_run', 'mutex_unavailable'];

  return {
    run_id: String(candidate.run_id ?? '').trim() || `sexpm_${crypto.randomUUID()}`,
    trigger,
    dry_run: candidate.dry_run === true,
    started_at: sanitizeIsoTimestamp(candidate.started_at),
    completed_at: sanitizeIsoTimestamp(candidate.completed_at),
    changed: candidate.changed === true,
    actions,
    rotation_performed: candidate.rotation_performed === true,
    pruned_verify_only_keys: sanitizePositiveInteger(candidate.pruned_verify_only_keys, 0, 0),
    active_key_id_before: candidate.active_key_id_before ? String(candidate.active_key_id_before) : null,
    active_key_id_after: candidate.active_key_id_after ? String(candidate.active_key_id_after) : null,
    key_count_before: sanitizePositiveInteger(candidate.key_count_before, 0, 0),
    key_count_after: sanitizePositiveInteger(candidate.key_count_after, 0, 0),
    lease: {
      holder_id: leaseCandidate && typeof leaseCandidate === 'object' ? String((leaseCandidate as any).holder_id ?? '') || null : null,
      expires_at:
        leaseCandidate && typeof leaseCandidate === 'object'
          ? ((leaseCandidate as any).expires_at ? sanitizeIsoTimestamp((leaseCandidate as any).expires_at) : null)
          : null,
      is_holder: Boolean((leaseCandidate as any)?.is_holder),
      acquired: Boolean((leaseCandidate as any)?.acquired)
    },
    ...(allowedSkippedReasons.includes(skippedReason)
      ? { skipped_reason: skippedReason as SecurityExportSigningMaintenanceRunSummary['skipped_reason'] }
      : {})
  };
}

function sanitizeMaintenanceEnvelope(value: unknown): {
  lastRun: SecurityExportSigningMaintenanceRunSummary | null;
  history: SecurityExportSigningMaintenanceRunSummary[];
} {
  if (!value || typeof value !== 'object') {
    return {
      lastRun: null,
      history: []
    };
  }

  const candidate = value as {
    lastRun?: unknown;
    history?: unknown[];
  };

  const history = Array.isArray(candidate.history)
    ? candidate.history
        .map((entry) => sanitizeMaintenanceRunSummary(entry))
        .filter((entry): entry is SecurityExportSigningMaintenanceRunSummary => Boolean(entry))
    : [];

  return {
    lastRun: sanitizeMaintenanceRunSummary(candidate.lastRun) ?? history[0] ?? null,
    history
  };
}

function withFileMutexSync<T>(
  lockPath: string,
  options: {
    waitMs?: number;
    pollMs?: number;
    staleMs?: number;
  },
  operation: () => T
): T | null {
  const waitMs = Math.max(1, Math.round(options.waitMs ?? DEFAULT_MUTEX_WAIT_MS));
  const pollMs = Math.max(1, Math.round(options.pollMs ?? DEFAULT_MUTEX_POLL_MS));
  const staleMs = Math.max(waitMs * 2, Math.round(options.staleMs ?? waitMs * 2));
  const deadline = Date.now() + waitMs;

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  while (Date.now() <= deadline) {
    let fd: number | null = null;
    let acquired = false;

    try {
      fd = fs.openSync(lockPath, 'wx');
      acquired = true;
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }), 'utf8');
      return operation();
    } catch (error) {
      const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== 'EEXIST') {
        throw error;
      }

      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        // lock disappeared between stat attempts
      }

      sleepSync(pollMs);
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // noop
        }
      }

      if (acquired) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // noop
        }
      }
    }
  }

  return null;
}

class SecurityExportSigningRegistry {
  private readonly filePath: string;
  private readonly storeMutexPath: string;
  private readonly masterKey: Buffer;
  private readonly maxVerifyKeys: number;
  private readonly defaultPolicy: SecurityExportSigningLifecyclePolicy;
  private readonly maintenanceIntervalMs: number | null;
  private readonly maintenanceIntervalMinutes: number | null;
  private readonly maintenanceLeaseTtlMs: number;
  private readonly maintenanceLeaseTtlSeconds: number;
  private readonly maintenanceHistoryLimit: number;
  private readonly instanceId: string;
  private keys: SecurityExportSigningKeyRecord[] = [];
  private policy: SecurityExportSigningLifecyclePolicy;
  private revision = 0;
  private updatedAt: string | null = null;
  private lease: SecurityExportSigningLeaseState | null = null;
  private lastMaintenanceRun: SecurityExportSigningMaintenanceRunSummary | null = null;
  private maintenanceHistory: SecurityExportSigningMaintenanceRunSummary[] = [];
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private lastLoadedMtimeMs = 0;

  constructor(options: SecurityExportSigningRegistryOptions) {
    this.filePath = options.filePath;
    this.storeMutexPath = `${options.filePath}.lock`;
    this.masterKey = options.masterKey;
    this.maxVerifyKeys = Math.max(1, options.maxVerifyKeys ?? 4);
    this.defaultPolicy = normalizeLifecyclePolicy(
      options.defaultPolicy ?? DEFAULT_SECURITY_EXPORT_SIGNING_LIFECYCLE_POLICY,
      DEFAULT_SECURITY_EXPORT_SIGNING_LIFECYCLE_POLICY
    );
    this.policy = this.defaultPolicy;
    const rawIntervalMs = Number(options.maintenanceIntervalMs ?? 0);
    this.maintenanceIntervalMs = Number.isFinite(rawIntervalMs) && rawIntervalMs > 0 ? Math.max(1000, Math.round(rawIntervalMs)) : null;
    this.maintenanceIntervalMinutes = this.maintenanceIntervalMs ? Number((this.maintenanceIntervalMs / 60000).toFixed(3)) : null;
    const defaultLeaseTtlMs = this.maintenanceIntervalMs ? this.maintenanceIntervalMs * 2 : 600_000;
    const configuredLeaseTtlMs = Number(options.maintenanceLeaseTtlMs ?? defaultLeaseTtlMs);
    this.maintenanceLeaseTtlMs = Number.isFinite(configuredLeaseTtlMs) && configuredLeaseTtlMs > 0
      ? Math.max(1_000, Math.round(configuredLeaseTtlMs))
      : Math.max(1_000, Math.round(defaultLeaseTtlMs));
    this.maintenanceLeaseTtlSeconds = Math.max(1, Math.round(this.maintenanceLeaseTtlMs / 1000));
    this.maintenanceHistoryLimit = Math.max(1, options.maintenanceHistoryLimit ?? 25);
    this.instanceId = `sexpi_${crypto.randomUUID()}`;
    this.syncFromDisk(true);
    this.ensureActiveKeySync();
    this.startMaintenanceTimer();
  }

  listKeySummaries(): SecurityExportSigningKeySummary[] {
    const now = Date.now();
    this.syncFromDisk();
    this.runMaintenance({ now, allowAutoRotate: false, trigger: 'request' });
    return this.keys.map((record) => this.toKeySummary(record, now));
  }

  getPublicJwks(): SecurityExportPublicJwks {
    const now = Date.now();
    this.syncFromDisk();
    this.runMaintenance({ now, allowAutoRotate: false, trigger: 'request' });
    const activeKey = this.getActiveKey();
    return {
      object: 'jwks',
      generated_at: new Date(now).toISOString(),
      active_key_id: activeKey.key_id,
      keys: this.keys.map((record) => record.public_jwk)
    };
  }

  getLifecyclePolicy(): SecurityExportSigningLifecyclePolicy {
    this.syncFromDisk();
    return { ...this.policy };
  }

  async updateLifecyclePolicy(nextPolicy: SecurityExportSigningLifecyclePolicy): Promise<SecurityExportSigningLifecyclePolicy> {
    const normalizedPolicy = normalizeLifecyclePolicy(nextPolicy, this.defaultPolicy);
    this.withRequiredStoreMutation(() => {
      this.syncFromDisk(true);
      this.policy = normalizedPolicy;
      const preview = this.computeMaintenancePreview(Date.now(), true);
      if (preview.changed) {
        this.applyMaintenancePreview(preview);
        this.recordMaintenanceRun(this.buildMaintenanceSummary({
          trigger: 'admin',
          now: Date.now(),
          preview,
          lease: this.getLeaseForResponse(Date.now(), false),
          acquiredLease: false,
          dryRun: false
        }));
      }
      this.bumpRevision();
      this.persistSync();
    });

    return this.getLifecyclePolicy();
  }

  getLifecycleState(): SecurityExportSigningLifecycleState {
    const now = Date.now();
    this.syncFromDisk();
    this.runMaintenance({ now, allowAutoRotate: false, trigger: 'request' });
    const activeKey = this.getActiveKey();
    const activeSummary = this.toKeySummary(activeKey, now);
    const verifyOnlySummaries = this.keys.filter((entry) => entry.status === 'verify_only').map((entry) => this.toKeySummary(entry, now));
    const prunableVerifyOnly = verifyOnlySummaries.filter((entry) => entry.lifecycle.retention_expired);
    const oldestVerifyOnly = verifyOnlySummaries
      .map((entry) => entry.deactivated_at ?? null)
      .filter((entry): entry is string => Boolean(entry))
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
    const nextPruneAt = verifyOnlySummaries
      .map((entry) => entry.lifecycle.retained_until ?? null)
      .filter((entry): entry is string => Boolean(entry))
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;

    const alerts: SecurityExportSigningLifecycleAlert[] = [];
    if (activeSummary.lifecycle.expired) {
      alerts.push('active_key_expired');
    } else {
      if (activeSummary.lifecycle.rotation_due) {
        alerts.push('active_key_rotation_due');
      }
      if (activeSummary.lifecycle.expiring_soon) {
        alerts.push('active_key_expiring_soon');
      }
    }
    if (prunableVerifyOnly.length > 0) {
      alerts.push('verify_only_key_retention_due');
    }

    const status = activeSummary.lifecycle.expired
      ? 'expired'
      : activeSummary.lifecycle.rotation_due
        ? 'rotation_due'
        : activeSummary.lifecycle.expiring_soon || prunableVerifyOnly.length > 0
          ? 'warning'
          : 'healthy';

    return {
      object: 'security_export_signing_lifecycle',
      generated_at: new Date(now).toISOString(),
      public_keys_url: SECURITY_EXPORT_JWKS_PATH,
      maintenance_interval_minutes: this.maintenanceIntervalMinutes,
      active_key_id: activeSummary.key_id,
      status,
      alerts,
      policy: this.getLifecyclePolicy(),
      active_key: activeSummary,
      verify_only: {
        total: verifyOnlySummaries.length,
        prunable: prunableVerifyOnly.length,
        oldest_deactivated_at: oldestVerifyOnly,
        next_prune_at: nextPruneAt
      }
    };
  }

  getMaintenanceState(): SecurityExportSigningMaintenanceState {
    const now = Date.now();
    this.syncFromDisk();
    const lease = this.getLeaseForResponse(now, false);
    return {
      object: 'security_export_signing_maintenance',
      generated_at: new Date(now).toISOString(),
      instance_id: this.instanceId,
      revision: this.revision,
      updated_at: this.updatedAt,
      maintenance_interval_minutes: this.maintenanceIntervalMinutes,
      lease_ttl_seconds: this.maintenanceLeaseTtlSeconds,
      leader: {
        holder_id: lease.holder_id,
        expires_at: lease.expires_at,
        is_holder: lease.is_holder,
        active: Boolean(lease.expires_at)
      },
      last_run: this.lastMaintenanceRun,
      history: this.maintenanceHistory.slice(0, this.maintenanceHistoryLimit)
    };
  }

  getActiveKeySummary(): SecurityExportSigningKeySummary {
    const now = Date.now();
    this.syncFromDisk();
    this.runMaintenance({ now, allowAutoRotate: false, trigger: 'request' });
    return this.toKeySummary(this.getActiveKey(), now);
  }

  resetForTests(): void {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }

    this.keys = [];
    this.policy = this.defaultPolicy;
    this.revision = 0;
    this.updatedAt = null;
    this.lease = null;
    this.lastMaintenanceRun = null;
    this.maintenanceHistory = [];
    this.lastLoadedMtimeMs = 0;

    try {
      fs.unlinkSync(this.filePath);
    } catch {
      // ignore missing test store
    }

    try {
      fs.unlinkSync(this.storeMutexPath);
    } catch {
      // ignore missing test lock file
    }

    this.ensureActiveKeySync();
    this.startMaintenanceTimer();
  }

  async rotate(): Promise<SecurityExportSigningKeySummary> {
    this.withRequiredStoreMutation(() => {
      this.syncFromDisk(true);
      this.rotateKeysInPlace(new Date().toISOString());
      this.bumpRevision();
      this.persistSync();
    });

    return this.getActiveKeySummary();
  }

  runMaintenanceNow(options: { dryRun?: boolean } = {}): SecurityExportSigningMaintenanceRunSummary {
    const now = Date.now();
    this.syncFromDisk();
    const preview = this.computeMaintenancePreview(now, true);

    if (options.dryRun) {
      return this.buildMaintenanceSummary({
        trigger: 'admin',
        now,
        preview,
        lease: this.getLeaseForResponse(now, false),
        acquiredLease: false,
        dryRun: true,
        skippedReason: preview.changed ? 'dry_run' : 'no_changes_required'
      });
    }

    return this.runMaintenance({ now, allowAutoRotate: true, trigger: 'admin', persistNoop: true });
  }

  signDetachedText(input: string): SecurityExportSigningResult {
    const now = Date.now();
    this.syncFromDisk();
    this.runMaintenance({ now, allowAutoRotate: true, trigger: 'request' });
    const activeKey = this.getActiveKey();
    const lifecycle = this.buildKeyLifecycle(activeKey, now);
    if (lifecycle.expired) {
      throw new SecurityExportSigningError(
        'Active security export signing key is expired. Rotate the key or re-enable auto-rotation before exporting.',
        'active_key_expired'
      );
    }

    const privateJwk = decryptJson<SecurityExportPrivateJwk>(this.masterKey, activeKey.private_jwk);
    const privateKey = createPrivateKeyFromJwk(privateJwk);
    const signedAt = new Date().toISOString();
    const signature = crypto.sign(null, Buffer.from(input), privateKey).toString('base64url');

    return {
      algorithm: activeKey.algorithm,
      key_id: activeKey.key_id,
      signature,
      signed_at: signedAt
    };
  }

  verifyDetachedText(input: string, signature: SecurityExportSignature | null | undefined): SecurityExportSignatureVerification {
    this.syncFromDisk();
    this.runMaintenance({ now: Date.now(), allowAutoRotate: false, trigger: 'request' });

    if (!signature) {
      return {
        verified: false,
        algorithm: SUPPORTED_EXPORT_SIGNATURE_ALGORITHM,
        key_id: null,
        payload_sha256: null,
        public_keys_url: SECURITY_EXPORT_JWKS_PATH,
        reason: 'signature_missing'
      };
    }

    if (signature.algorithm !== SUPPORTED_EXPORT_SIGNATURE_ALGORITHM) {
      return {
        verified: false,
        algorithm: SUPPORTED_EXPORT_SIGNATURE_ALGORITHM,
        key_id: signature.key_id,
        payload_sha256: signature.payload_sha256,
        public_keys_url: SECURITY_EXPORT_JWKS_PATH,
        reason: 'unsupported_algorithm'
      };
    }

    const key = this.keys.find((entry) => entry.key_id === signature.key_id);
    if (!key) {
      return {
        verified: false,
        algorithm: signature.algorithm,
        key_id: signature.key_id,
        payload_sha256: signature.payload_sha256,
        public_keys_url: SECURITY_EXPORT_JWKS_PATH,
        reason: 'unknown_key'
      };
    }

    const payloadSha256 = sha256Hex(input);
    if (signature.payload_sha256 !== payloadSha256) {
      return {
        verified: false,
        algorithm: signature.algorithm,
        key_id: signature.key_id,
        payload_sha256: signature.payload_sha256,
        public_keys_url: SECURITY_EXPORT_JWKS_PATH,
        reason: 'payload_sha256_mismatch'
      };
    }

    const publicKey = createPublicKeyFromJwk(key.public_jwk);
    const verified = crypto.verify(null, Buffer.from(input), publicKey, Buffer.from(signature.signature, 'base64url'));

    return {
      verified,
      algorithm: signature.algorithm,
      key_id: signature.key_id,
      payload_sha256: payloadSha256,
      public_keys_url: SECURITY_EXPORT_JWKS_PATH,
      ...(verified ? {} : { reason: 'signature_invalid' as const })
    };
  }

  private syncFromDisk(force = false): boolean {
    const nextMtimeMs = statMtimeMs(this.filePath);
    if (!force && nextMtimeMs > 0 && nextMtimeMs === this.lastLoadedMtimeMs) {
      return false;
    }

    const snapshot = readJsonFileSync<SecurityExportSigningStoreSnapshot>(this.filePath);
    this.lastLoadedMtimeMs = nextMtimeMs;
    if (!snapshot) {
      return false;
    }

    this.policy = normalizeLifecyclePolicy(snapshot.policy, this.defaultPolicy);
    this.revision = sanitizePositiveInteger(snapshot.revision, this.revision, 0);
    this.updatedAt = sanitizeIsoTimestamp(snapshot.updatedAt);
    this.lease = sanitizeLeaseState(snapshot.lease);
    const maintenance = sanitizeMaintenanceEnvelope(snapshot.maintenance);
    this.lastMaintenanceRun = maintenance.lastRun;
    this.maintenanceHistory = maintenance.history.slice(0, this.maintenanceHistoryLimit);
    if (!Array.isArray(snapshot.keys)) {
      this.keys = [];
      return true;
    }

    this.keys = snapshot.keys
      .map((entry) => sanitizeStoredKey(entry))
      .filter((entry): entry is SecurityExportSigningKeyRecord => Boolean(entry));

    return true;
  }

  private ensureActiveKeySync(): void {
    this.runMaintenance({ now: Date.now(), allowAutoRotate: true, trigger: 'startup', persistNoop: false });
  }

  private runMaintenance(params: {
    now: number;
    allowAutoRotate: boolean;
    trigger: SecurityExportSigningMaintenanceTrigger;
    persistNoop?: boolean;
  }): SecurityExportSigningMaintenanceRunSummary {
    this.syncFromDisk();
    const preview = this.computeMaintenancePreview(params.now, params.allowAutoRotate);
    const leaseBefore = this.getLeaseForResponse(params.now, false);

    if (!preview.changed) {
      const summary = this.buildMaintenanceSummary({
        trigger: params.trigger,
        now: params.now,
        preview,
        lease: leaseBefore,
        acquiredLease: false,
        dryRun: false,
        skippedReason: 'no_changes_required'
      });

      if (params.trigger === 'admin' && params.persistNoop) {
        this.withRequiredStoreMutation(() => {
          this.syncFromDisk(true);
          this.recordMaintenanceRun(summary);
          this.bumpRevision();
          this.persistSync();
        });
      }

      return summary;
    }

    const result = this.withStoreMutation(params.trigger === 'admin' ? 'required' : 'best_effort', () => {
      this.syncFromDisk(true);
      const activeLease = this.getActiveLease(params.now);
      if (activeLease && activeLease.holder_id !== this.instanceId) {
        return this.buildMaintenanceSummary({
          trigger: params.trigger,
          now: params.now,
          preview: this.computeMaintenancePreview(params.now, params.allowAutoRotate),
          lease: this.getLeaseForResponse(params.now, false),
          acquiredLease: false,
          dryRun: false,
          skippedReason: 'lease_held_by_other'
        });
      }

      this.acquireLease(params.now);
      const lockedPreview = this.computeMaintenancePreview(params.now, params.allowAutoRotate);
      if (!lockedPreview.changed) {
        const summary = this.buildMaintenanceSummary({
          trigger: params.trigger,
          now: params.now,
          preview: lockedPreview,
          lease: this.getLeaseForResponse(params.now, true),
          acquiredLease: true,
          dryRun: false,
          skippedReason: 'no_changes_required'
        });

        if (params.trigger === 'admin' && params.persistNoop) {
          this.recordMaintenanceRun(summary);
          this.bumpRevision();
          this.persistSync();
        }

        return summary;
      }

      this.applyMaintenancePreview(lockedPreview);
      const summary = this.buildMaintenanceSummary({
        trigger: params.trigger,
        now: params.now,
        preview: lockedPreview,
        lease: this.getLeaseForResponse(params.now, true),
        acquiredLease: true,
        dryRun: false
      });
      this.recordMaintenanceRun(summary);
      this.bumpRevision();
      this.persistSync();
      return summary;
    });

    if (!result) {
      return this.buildMaintenanceSummary({
        trigger: params.trigger,
        now: params.now,
        preview,
        lease: leaseBefore,
        acquiredLease: false,
        dryRun: false,
        skippedReason: 'mutex_unavailable'
      });
    }

    return result;
  }

  private withRequiredStoreMutation<T>(operation: () => T): T {
    const result = this.withStoreMutation('required', operation);
    if (result === null) {
      throw new SecurityExportSigningError('Security export signing store is busy. Retry the operation.', 'store_busy');
    }

    return result;
  }

  private withStoreMutation<T>(mode: 'required' | 'best_effort', operation: () => T): T | null {
    const result = withFileMutexSync(
      this.storeMutexPath,
      {
        waitMs: mode === 'required' ? DEFAULT_MUTEX_WAIT_MS : 100,
        pollMs: DEFAULT_MUTEX_POLL_MS,
        staleMs: Math.max(DEFAULT_MUTEX_WAIT_MS * 4, this.maintenanceLeaseTtlMs)
      },
      operation
    );

    if (result === null && mode === 'required') {
      throw new SecurityExportSigningError('Security export signing store is busy. Retry the operation.', 'store_busy');
    }

    return result;
  }

  private startMaintenanceTimer(): void {
    if (!this.maintenanceIntervalMs || this.maintenanceTimer) {
      return;
    }

    this.maintenanceTimer = setInterval(() => {
      try {
        this.runMaintenance({ now: Date.now(), allowAutoRotate: true, trigger: 'timer' });
      } catch {
        // fail-closed for timer path; request/manual paths will surface errors when needed.
      }
    }, this.maintenanceIntervalMs);

    this.maintenanceTimer.unref?.();
  }

  private buildKeyLifecycle(record: SecurityExportSigningKeyRecord, now: number): SecurityExportSigningKeyLifecycle {
    const activatedAtMs = Date.parse(record.activated_at);
    const activeAgeMs = Math.max(0, now - activatedAtMs);

    if (record.status === 'active') {
      const rotationDueAt = activatedAtMs + hoursToMs(this.policy.rotate_after_hours);
      const expiresAt = activatedAtMs + hoursToMs(this.policy.expire_after_hours);
      const warnAt = expiresAt - hoursToMs(this.policy.warn_before_hours);
      const expired = now >= expiresAt;
      const rotationDue = now >= rotationDueAt;
      const expiringSoon = !expired && now >= warnAt;

      return {
        age_hours: roundHours(activeAgeMs),
        rotation_due_at: new Date(rotationDueAt).toISOString(),
        expires_at: new Date(expiresAt).toISOString(),
        rotation_due: rotationDue,
        expiring_soon: expiringSoon,
        expired,
        retention_expired: false
      };
    }

    const retentionBaseMs = Date.parse(record.deactivated_at ?? record.activated_at);
    const retainedUntil = retentionBaseMs + hoursToMs(this.policy.verify_retention_hours);

    return {
      age_hours: roundHours(Math.max(0, now - retentionBaseMs)),
      retained_until: new Date(retainedUntil).toISOString(),
      rotation_due: false,
      expiring_soon: false,
      expired: false,
      retention_expired: now >= retainedUntil
    };
  }

  private toKeySummary(record: SecurityExportSigningKeyRecord, now: number): SecurityExportSigningKeySummary {
    return {
      key_id: record.key_id,
      algorithm: record.algorithm,
      status: record.status,
      created_at: record.created_at,
      activated_at: record.activated_at,
      deactivated_at: record.deactivated_at,
      fingerprint: record.fingerprint,
      public_jwk: record.public_jwk,
      lifecycle: this.buildKeyLifecycle(record, now)
    };
  }

  private getActiveKey(): SecurityExportSigningKeyRecord {
    const activeKey = this.keys.find((entry) => entry.status === 'active');
    if (!activeKey) {
      throw new SecurityExportSigningError('Active security export signing key is unavailable.', 'active_key_unavailable');
    }

    return activeKey;
  }

  private createKeyRecord(status: SecurityExportSigningKeyStatus, activatedAt: string): SecurityExportSigningKeyRecord {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const keyId = `sexp_${crypto.randomUUID()}`;
    const publicJwk = buildPublicJwk(keyId, publicKey);
    const privateJwk = buildPrivateJwk(keyId, privateKey);

    return {
      key_id: keyId,
      algorithm: SUPPORTED_EXPORT_SIGNATURE_ALGORITHM,
      status,
      created_at: activatedAt,
      activated_at: activatedAt,
      fingerprint: computeFingerprint(publicJwk),
      public_jwk: publicJwk,
      private_jwk: encryptJson(this.masterKey, privateJwk)
    };
  }

  private normalizeKeysInPlace(keys: SecurityExportSigningKeyRecord[], now: number): { changed: boolean; bootstrapped: boolean } {
    if (keys.length === 0) {
      keys.push(this.createKeyRecord('active', new Date(now).toISOString()));
      return {
        changed: true,
        bootstrapped: true
      };
    }

    const ordered = [...keys].sort((left, right) => Date.parse(right.activated_at) - Date.parse(left.activated_at));
    let activeAssigned = false;
    let changed = false;
    const normalized: SecurityExportSigningKeyRecord[] = [];
    const normalizedAt = new Date(now).toISOString();

    for (const key of ordered) {
      if (!activeAssigned) {
        if (key.status !== 'active') {
          key.status = 'active';
          changed = true;
        }
        key.activated_at = key.activated_at || normalizedAt;
        if (key.deactivated_at) {
          delete key.deactivated_at;
          changed = true;
        }
        activeAssigned = true;
        normalized.push(key);
        continue;
      }

      if (key.status !== 'verify_only') {
        key.status = 'verify_only';
        changed = true;
      }
      if (!key.deactivated_at) {
        key.deactivated_at = normalizedAt;
        changed = true;
      }
      normalized.push(key);
    }

    keys.splice(0, keys.length, ...normalized);
    return {
      changed,
      bootstrapped: false
    };
  }

  private rotateKeysInPlace(rotatedAt: string): void {
    for (const key of this.keys) {
      if (key.status === 'active') {
        key.status = 'verify_only';
        key.deactivated_at = rotatedAt;
      }
    }

    this.keys.unshift(this.createKeyRecord('active', rotatedAt));
    this.pruneVerifyOnlyKeysInPlace(this.keys, Date.parse(rotatedAt));
  }

  private rotateKeysOnCopy(keys: SecurityExportSigningKeyRecord[], rotatedAt: string): SecurityExportSigningKeyRecord[] {
    for (const key of keys) {
      if (key.status === 'active') {
        key.status = 'verify_only';
        key.deactivated_at = rotatedAt;
      }
    }

    keys.unshift(this.createKeyRecord('active', rotatedAt));
    this.pruneVerifyOnlyKeysInPlace(keys, Date.parse(rotatedAt));
    return keys;
  }

  private pruneVerifyOnlyKeysInPlace(keys: SecurityExportSigningKeyRecord[], now: number): { changed: boolean; prunedCount: number } {
    const activeKeys = keys.filter((entry) => entry.status === 'active');
    const retainedVerifyOnlyKeys = keys
      .filter((entry) => entry.status === 'verify_only')
      .filter((entry) => {
        const baseTimestamp = Date.parse(entry.deactivated_at ?? entry.created_at);
        return now < baseTimestamp + hoursToMs(this.policy.verify_retention_hours);
      })
      .sort((left, right) => {
        const leftAt = Date.parse(left.deactivated_at ?? left.created_at);
        const rightAt = Date.parse(right.deactivated_at ?? right.created_at);
        return rightAt - leftAt;
      })
      .slice(0, this.maxVerifyKeys);

    const nextKeys = [...activeKeys, ...retainedVerifyOnlyKeys].sort(
      (left, right) => Date.parse(right.activated_at) - Date.parse(left.activated_at)
    );

    const changed =
      nextKeys.length !== keys.length ||
      nextKeys.some((entry, index) => {
        const current = keys[index];
        return !current || current.key_id !== entry.key_id || current.status !== entry.status;
      });

    const prunedCount = Math.max(0, keys.length - nextKeys.length);
    keys.splice(0, keys.length, ...nextKeys);
    return {
      changed,
      prunedCount
    };
  }

  private computeMaintenancePreview(now: number, allowAutoRotate: boolean): SecurityExportSigningMaintenancePreview {
    const workingKeys = structuredClone(this.keys) as SecurityExportSigningKeyRecord[];
    const actions: SecurityExportSigningMaintenanceAction[] = [];
    const beforeActive = workingKeys.find((entry) => entry.status === 'active')?.key_id ?? null;
    const keyCountBefore = workingKeys.length;

    const normalized = this.normalizeKeysInPlace(workingKeys, now);
    if (normalized.bootstrapped) {
      actions.push('bootstrap_active_key');
    } else if (normalized.changed) {
      actions.push('normalize_active_key');
    }

    let rotationPerformed = false;
    if (allowAutoRotate && this.policy.auto_rotate) {
      const activeKey = workingKeys.find((entry) => entry.status === 'active');
      if (activeKey) {
        const lifecycle = this.buildKeyLifecycle(activeKey, now);
        if (lifecycle.rotation_due || lifecycle.expired) {
          this.rotateKeysOnCopy(workingKeys, new Date(now).toISOString());
          rotationPerformed = true;
          actions.push(lifecycle.expired ? 'rotate_expired_active_key' : 'rotate_due_active_key');
        }
      }
    }

    const prune = this.pruneVerifyOnlyKeysInPlace(workingKeys, now);
    if (prune.prunedCount > 0) {
      actions.push('prune_verify_only_keys');
    }

    const afterActive = workingKeys.find((entry) => entry.status === 'active')?.key_id ?? null;
    return {
      nextKeys: workingKeys,
      changed: normalized.changed || rotationPerformed || prune.changed,
      actions,
      rotationPerformed,
      prunedVerifyOnlyKeys: prune.prunedCount,
      activeKeyIdBefore: beforeActive,
      activeKeyIdAfter: afterActive,
      keyCountBefore,
      keyCountAfter: workingKeys.length
    };
  }

  private applyMaintenancePreview(preview: SecurityExportSigningMaintenancePreview): void {
    this.keys = preview.nextKeys;
  }

  private getActiveLease(now: number): SecurityExportSigningLeaseState | null {
    if (!this.lease) {
      return null;
    }

    return safeDateMs(this.lease.expires_at) > now ? this.lease : null;
  }

  private acquireLease(now: number): void {
    const current = this.getActiveLease(now);
    const acquiredAt = current?.holder_id === this.instanceId ? current.acquired_at : new Date(now).toISOString();
    const token = current?.holder_id === this.instanceId ? current.token : crypto.randomUUID();
    this.lease = {
      holder_id: this.instanceId,
      token,
      acquired_at: acquiredAt,
      updated_at: new Date(now).toISOString(),
      expires_at: new Date(now + this.maintenanceLeaseTtlMs).toISOString()
    };
  }

  private getLeaseForResponse(now: number, acquired: boolean): SecurityExportSigningMaintenanceRunSummary['lease'] {
    const activeLease = this.getActiveLease(now);
    return {
      holder_id: activeLease?.holder_id ?? null,
      expires_at: activeLease?.expires_at ?? null,
      is_holder: activeLease?.holder_id === this.instanceId,
      acquired
    };
  }

  private buildMaintenanceSummary(params: {
    trigger: SecurityExportSigningMaintenanceTrigger;
    now: number;
    preview: SecurityExportSigningMaintenancePreview;
    lease: SecurityExportSigningMaintenanceRunSummary['lease'];
    acquiredLease: boolean;
    dryRun: boolean;
    skippedReason?: SecurityExportSigningMaintenanceRunSummary['skipped_reason'];
  }): SecurityExportSigningMaintenanceRunSummary {
    const skippedReason = params.skippedReason;
    const changed = !params.dryRun && !skippedReason && params.preview.changed;
    return {
      run_id: `sexpm_${crypto.randomUUID()}`,
      trigger: params.trigger,
      dry_run: params.dryRun,
      started_at: new Date(params.now).toISOString(),
      completed_at: new Date().toISOString(),
      changed,
      actions: params.preview.actions,
      rotation_performed: changed ? params.preview.rotationPerformed : false,
      pruned_verify_only_keys: changed ? params.preview.prunedVerifyOnlyKeys : 0,
      active_key_id_before: params.preview.activeKeyIdBefore,
      active_key_id_after:
        changed
          ? params.preview.activeKeyIdAfter
          : params.preview.activeKeyIdBefore ?? params.preview.activeKeyIdAfter,
      key_count_before: params.preview.keyCountBefore,
      key_count_after: changed ? params.preview.keyCountAfter : params.preview.keyCountBefore,
      lease: {
        ...params.lease,
        acquired: params.acquiredLease
      },
      ...(skippedReason ? { skipped_reason: skippedReason } : {})
    };
  }

  private recordMaintenanceRun(summary: SecurityExportSigningMaintenanceRunSummary): void {
    this.lastMaintenanceRun = summary;
    this.maintenanceHistory = [summary, ...this.maintenanceHistory].slice(0, this.maintenanceHistoryLimit);
  }

  private bumpRevision(): void {
    this.revision += 1;
  }

  private persistSync(): void {
    this.updatedAt = new Date().toISOString();
    writeJsonFileAtomicSync(this.filePath, {
      version: SIGNING_STORE_VERSION,
      updatedAt: this.updatedAt,
      revision: this.revision,
      policy: this.policy,
      lease: this.lease,
      maintenance: {
        lastRun: this.lastMaintenanceRun,
        history: this.maintenanceHistory.slice(0, this.maintenanceHistoryLimit)
      },
      keys: this.keys
    });
    this.lastLoadedMtimeMs = statMtimeMs(this.filePath);
  }
}

export const DEFAULT_SECURITY_EXPORT_SIGNING_LIFECYCLE_POLICY: SecurityExportSigningLifecyclePolicy = {
  auto_rotate: config.security.exportSigningAutoRotateEnabled,
  rotate_after_hours: config.security.exportSigningRotateAfterHours,
  expire_after_hours: config.security.exportSigningExpireAfterHours,
  warn_before_hours: config.security.exportSigningWarnBeforeHours,
  verify_retention_hours: config.security.exportSigningVerifyRetentionHours
};

export function createSecurityExportSigningRegistry(options: SecurityExportSigningRegistryOptions) {
  return new SecurityExportSigningRegistry(options);
}

export function signSecurityAuditExportBundle(
  bundle: SecurityAuditExportBundle,
  registry = securityExportSigningRegistry
): SecurityAuditExportBundle {
  const canonicalPayload = buildCanonicalBundlePayload(bundle);
  const signing = registry.signDetachedText(canonicalPayload);

  return {
    ...stripBundleSignature(bundle),
    signature: buildSignatureMetadata(signing, canonicalPayload)
  };
}

export function ensureSignedSecurityAuditExportBundle(
  bundle: SecurityAuditExportBundle,
  registry = securityExportSigningRegistry
): SecurityAuditExportBundle {
  return bundle.signature ? bundle : signSecurityAuditExportBundle(bundle, registry);
}

export function verifySecurityAuditExportBundleSignature(
  bundle: SecurityAuditExportBundle,
  registry = securityExportSigningRegistry
): SecurityExportSignatureVerification {
  const canonicalPayload = buildCanonicalBundlePayload(bundle);
  return registry.verifyDetachedText(canonicalPayload, bundle.signature ?? null);
}

export function getSecurityExportJwksPath(): string {
  return SECURITY_EXPORT_JWKS_PATH;
}

export const securityExportSigningRegistry = createSecurityExportSigningRegistry({
  filePath: config.storage.securityExportSigningStoreFile,
  masterKey: config.security.masterKey,
  maxVerifyKeys: config.security.exportSigningMaxVerifyKeys,
  defaultPolicy: DEFAULT_SECURITY_EXPORT_SIGNING_LIFECYCLE_POLICY,
  maintenanceIntervalMs: config.security.exportSigningMaintenanceIntervalMs,
  maintenanceLeaseTtlMs: config.security.exportSigningMaintenanceLeaseTtlMs,
  maintenanceHistoryLimit: config.security.exportSigningMaintenanceHistoryLimit
});

export const __private__ = {
  resetForTests() {
    securityExportSigningRegistry.resetForTests();
  }
};
