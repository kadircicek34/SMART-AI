import crypto from 'node:crypto';
import { config } from '../config.js';
import { readJsonFileSync, writeJsonFileAtomic } from '../persistence/json-file.js';
import type { SecurityAuditExportBundle } from './audit-log.js';

const SIGNING_STORE_VERSION = 2;
const SECURITY_EXPORT_JWKS_PATH = '/.well-known/smart-ai/security-export-keys.json';
const SUPPORTED_EXPORT_SIGNATURE_ALGORITHM = 'Ed25519' as const;
const SUPPORTED_EXPORT_SIGNATURE_ALG_HEADER = 'EdDSA' as const;
const MIN_POLICY_HOURS = 1 / 3600;
const MAX_POLICY_HOURS = 24 * 365 * 5;

type SecurityExportSigningLifecycleAlert =
  | 'active_key_rotation_due'
  | 'active_key_expiring_soon'
  | 'active_key_expired'
  | 'verify_only_key_retention_due';

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

type SecurityExportSigningStoreSnapshot = {
  version: number;
  updatedAt: string;
  policy?: unknown;
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
};

export class SecurityExportSigningError extends Error {
  readonly code: 'active_key_unavailable' | 'active_key_expired';
  readonly statusCode = 503;

  constructor(message: string, code: 'active_key_unavailable' | 'active_key_expired') {
    super(message);
    this.name = 'SecurityExportSigningError';
    this.code = code;
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

class SecurityExportSigningRegistry {
  private readonly filePath: string;
  private readonly masterKey: Buffer;
  private readonly maxVerifyKeys: number;
  private readonly defaultPolicy: SecurityExportSigningLifecyclePolicy;
  private readonly maintenanceIntervalMs: number | null;
  private readonly maintenanceIntervalMinutes: number | null;
  private keys: SecurityExportSigningKeyRecord[] = [];
  private policy: SecurityExportSigningLifecyclePolicy;
  private persistChain: Promise<void> = Promise.resolve();
  private maintenanceTimer: NodeJS.Timeout | null = null;

  constructor(options: SecurityExportSigningRegistryOptions) {
    this.filePath = options.filePath;
    this.masterKey = options.masterKey;
    this.maxVerifyKeys = Math.max(1, options.maxVerifyKeys ?? 4);
    this.defaultPolicy = normalizeLifecyclePolicy(options.defaultPolicy ?? DEFAULT_SECURITY_EXPORT_SIGNING_LIFECYCLE_POLICY, DEFAULT_SECURITY_EXPORT_SIGNING_LIFECYCLE_POLICY);
    this.policy = this.defaultPolicy;
    const rawIntervalMs = Number(options.maintenanceIntervalMs ?? 0);
    this.maintenanceIntervalMs = Number.isFinite(rawIntervalMs) && rawIntervalMs > 0 ? Math.max(1000, Math.round(rawIntervalMs)) : null;
    this.maintenanceIntervalMinutes = this.maintenanceIntervalMs ? Number((this.maintenanceIntervalMs / 60000).toFixed(3)) : null;
    this.hydrate();
    this.ensureActiveKeySync();
    this.startMaintenanceTimer();
  }

  listKeySummaries(): SecurityExportSigningKeySummary[] {
    const now = Date.now();
    this.runMaintenance({ now, allowAutoRotate: false });
    return this.keys.map((record) => this.toKeySummary(record, now));
  }

  getPublicJwks(): SecurityExportPublicJwks {
    const now = Date.now();
    this.runMaintenance({ now, allowAutoRotate: false });
    const activeKey = this.getActiveKey();
    return {
      object: 'jwks',
      generated_at: new Date(now).toISOString(),
      active_key_id: activeKey.key_id,
      keys: this.keys.map((record) => record.public_jwk)
    };
  }

  getLifecyclePolicy(): SecurityExportSigningLifecyclePolicy {
    return { ...this.policy };
  }

  async updateLifecyclePolicy(nextPolicy: SecurityExportSigningLifecyclePolicy): Promise<SecurityExportSigningLifecyclePolicy> {
    this.policy = normalizeLifecyclePolicy(nextPolicy, this.defaultPolicy);
    this.runMaintenance({ now: Date.now(), allowAutoRotate: true });
    await this.persist();
    return this.getLifecyclePolicy();
  }

  getLifecycleState(): SecurityExportSigningLifecycleState {
    const now = Date.now();
    this.runMaintenance({ now, allowAutoRotate: false });
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

  getActiveKeySummary(): SecurityExportSigningKeySummary {
    const now = Date.now();
    this.runMaintenance({ now, allowAutoRotate: false });
    return this.toKeySummary(this.getActiveKey(), now);
  }

  async rotate(): Promise<SecurityExportSigningKeySummary> {
    const rotatedAt = new Date().toISOString();
    this.rotateInMemory(rotatedAt);
    await this.persist();
    return this.getActiveKeySummary();
  }

  signDetachedText(input: string): SecurityExportSigningResult {
    const now = Date.now();
    this.runMaintenance({ now, allowAutoRotate: true });
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
    this.runMaintenance({ now: Date.now(), allowAutoRotate: false });

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

  private startMaintenanceTimer(): void {
    if (!this.maintenanceIntervalMs || this.maintenanceTimer) {
      return;
    }

    this.maintenanceTimer = setInterval(() => {
      this.runMaintenance({ now: Date.now(), allowAutoRotate: true });
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

  private hydrate(): void {
    const snapshot = readJsonFileSync<SecurityExportSigningStoreSnapshot>(this.filePath);
    if (!snapshot) {
      return;
    }

    this.policy = normalizeLifecyclePolicy(snapshot.policy, this.defaultPolicy);
    if (!Array.isArray(snapshot.keys)) {
      return;
    }

    this.keys = snapshot.keys
      .map((entry) => sanitizeStoredKey(entry))
      .filter((entry): entry is SecurityExportSigningKeyRecord => Boolean(entry));
  }

  private ensureActiveKeySync(): void {
    const now = Date.now();
    const changed = this.ensureSingleActiveKey(now) || this.pruneVerifyOnlyKeys(now);
    if (changed) {
      void this.persist();
    }
  }

  private runMaintenance(params: { now: number; allowAutoRotate: boolean }): void {
    let changed = this.ensureSingleActiveKey(params.now);
    if (params.allowAutoRotate && this.policy.auto_rotate) {
      const activeKey = this.keys.find((entry) => entry.status === 'active');
      if (activeKey) {
        const lifecycle = this.buildKeyLifecycle(activeKey, params.now);
        if (lifecycle.rotation_due || lifecycle.expired) {
          this.rotateInMemory(new Date(params.now).toISOString());
          changed = true;
        }
      }
    }

    if (this.pruneVerifyOnlyKeys(params.now)) {
      changed = true;
    }

    if (changed) {
      void this.persist();
    }
  }

  private ensureSingleActiveKey(now: number): boolean {
    if (this.keys.length === 0) {
      this.keys = [this.createKeyRecord('active', new Date(now).toISOString())];
      return true;
    }

    const ordered = [...this.keys].sort((left, right) => Date.parse(right.activated_at) - Date.parse(left.activated_at));
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

    this.keys = normalized;
    return changed;
  }

  private rotateInMemory(rotatedAt: string): void {
    for (const key of this.keys) {
      if (key.status === 'active') {
        key.status = 'verify_only';
        key.deactivated_at = rotatedAt;
      }
    }

    this.keys.unshift(this.createKeyRecord('active', rotatedAt));
    this.pruneVerifyOnlyKeys(Date.parse(rotatedAt));
  }

  private pruneVerifyOnlyKeys(now: number): boolean {
    const activeKeys = this.keys.filter((entry) => entry.status === 'active');
    const retainedVerifyOnlyKeys = this.keys
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
      nextKeys.length !== this.keys.length ||
      nextKeys.some((entry, index) => {
        const current = this.keys[index];
        return !current || current.key_id !== entry.key_id || current.status !== entry.status;
      });

    this.keys = nextKeys;
    return changed;
  }

  private async persist(): Promise<void> {
    this.persistChain = this.persistChain.catch(() => undefined).then(async () => {
      await writeJsonFileAtomic(this.filePath, {
        version: SIGNING_STORE_VERSION,
        updatedAt: new Date().toISOString(),
        policy: this.policy,
        keys: this.keys
      });
    });

    await this.persistChain;
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
  maintenanceIntervalMs: config.security.exportSigningMaintenanceIntervalMs
});
