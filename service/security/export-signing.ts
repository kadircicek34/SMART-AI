import crypto from 'node:crypto';
import { config } from '../config.js';
import { readJsonFileSync, writeJsonFileAtomic } from '../persistence/json-file.js';
import type { SecurityAuditExportBundle } from './audit-log.js';

const SIGNING_STORE_VERSION = 1;
const SECURITY_EXPORT_JWKS_PATH = '/.well-known/smart-ai/security-export-keys.json';
const SUPPORTED_EXPORT_SIGNATURE_ALGORITHM = 'Ed25519' as const;
const SUPPORTED_EXPORT_SIGNATURE_ALG_HEADER = 'EdDSA' as const;

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
  keys: unknown[];
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
};

export type SecurityExportPublicJwks = {
  object: 'jwks';
  generated_at: string;
  active_key_id: string;
  keys: SecurityExportOkpJwk[];
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
};

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
    fingerprint: String(candidate.fingerprint ?? computeFingerprint({
      kty: 'OKP',
      crv: 'Ed25519',
      x: String(publicJwk.x)
    })).trim(),
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

    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalizeJson(entryValue)}`)
      .join(',')}}`;
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

function buildSignatureMetadata(
  signing: SecurityExportSigningResult,
  canonicalPayload: string
): SecurityExportSignature {
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
  private keys: SecurityExportSigningKeyRecord[] = [];
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: SecurityExportSigningRegistryOptions) {
    this.filePath = options.filePath;
    this.masterKey = options.masterKey;
    this.maxVerifyKeys = Math.max(1, options.maxVerifyKeys ?? 4);
    this.hydrate();
    this.ensureActiveKeySync();
  }

  listKeySummaries(): SecurityExportSigningKeySummary[] {
    return this.keys.map((record) => ({
      key_id: record.key_id,
      algorithm: record.algorithm,
      status: record.status,
      created_at: record.created_at,
      activated_at: record.activated_at,
      deactivated_at: record.deactivated_at,
      fingerprint: record.fingerprint,
      public_jwk: record.public_jwk
    }));
  }

  getPublicJwks(): SecurityExportPublicJwks {
    const activeKey = this.getActiveKey();
    return {
      object: 'jwks',
      generated_at: new Date().toISOString(),
      active_key_id: activeKey.key_id,
      keys: this.keys.map((record) => record.public_jwk)
    };
  }

  getActiveKeySummary(): SecurityExportSigningKeySummary {
    const activeKey = this.getActiveKey();
    return {
      key_id: activeKey.key_id,
      algorithm: activeKey.algorithm,
      status: activeKey.status,
      created_at: activeKey.created_at,
      activated_at: activeKey.activated_at,
      deactivated_at: activeKey.deactivated_at,
      fingerprint: activeKey.fingerprint,
      public_jwk: activeKey.public_jwk
    };
  }

  async rotate(): Promise<SecurityExportSigningKeySummary> {
    const rotatedAt = new Date().toISOString();
    for (const key of this.keys) {
      if (key.status === 'active') {
        key.status = 'verify_only';
        key.deactivated_at = rotatedAt;
      }
    }

    this.keys.unshift(this.createKeyRecord('active', rotatedAt));
    this.pruneVerifyOnlyKeys();
    await this.persist();
    return this.getActiveKeySummary();
  }

  signDetachedText(input: string): SecurityExportSigningResult {
    const activeKey = this.getActiveKey();
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

  verifyDetachedText(
    input: string,
    signature: SecurityExportSignature | null | undefined
  ): SecurityExportSignatureVerification {
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

  private getActiveKey(): SecurityExportSigningKeyRecord {
    const activeKey = this.keys.find((entry) => entry.status === 'active');
    if (!activeKey) {
      throw new Error('Active security export signing key is unavailable.');
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
    if (!snapshot?.keys || !Array.isArray(snapshot.keys)) {
      return;
    }

    this.keys = snapshot.keys
      .map((entry) => sanitizeStoredKey(entry))
      .filter((entry): entry is SecurityExportSigningKeyRecord => Boolean(entry));
  }

  private ensureActiveKeySync(): void {
    const activeCount = this.keys.filter((entry) => entry.status === 'active').length;
    if (activeCount === 1) {
      this.pruneVerifyOnlyKeys();
      return;
    }

    const activatedAt = new Date().toISOString();
    let activeAssigned = false;
    for (const key of this.keys) {
      if (!activeAssigned) {
        key.status = 'active';
        key.activated_at = key.activated_at || activatedAt;
        delete key.deactivated_at;
        activeAssigned = true;
      } else {
        key.status = 'verify_only';
        key.deactivated_at = key.deactivated_at ?? activatedAt;
      }
    }

    if (!activeAssigned) {
      this.keys = [this.createKeyRecord('active', activatedAt)];
    }

    this.pruneVerifyOnlyKeys();
    void this.persist();
  }

  private pruneVerifyOnlyKeys(): void {
    const activeKeys = this.keys.filter((entry) => entry.status === 'active');
    const verifyOnlyKeys = this.keys
      .filter((entry) => entry.status === 'verify_only')
      .sort((left, right) => {
        const leftAt = Date.parse(left.deactivated_at ?? left.created_at);
        const rightAt = Date.parse(right.deactivated_at ?? right.created_at);
        return rightAt - leftAt;
      })
      .slice(0, this.maxVerifyKeys);

    this.keys = [...activeKeys, ...verifyOnlyKeys].sort((left, right) => {
      const leftAt = Date.parse(left.activated_at);
      const rightAt = Date.parse(right.activated_at);
      return rightAt - leftAt;
    });
  }

  private async persist(): Promise<void> {
    this.persistChain = this.persistChain.catch(() => undefined).then(async () => {
      await writeJsonFileAtomic(this.filePath, {
        version: SIGNING_STORE_VERSION,
        updatedAt: new Date().toISOString(),
        keys: this.keys
      });
    });

    await this.persistChain;
  }
}

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
  maxVerifyKeys: config.security.exportSigningMaxVerifyKeys
});
