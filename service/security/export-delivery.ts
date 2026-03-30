import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { config } from '../config.js';
import { writeJsonFileAtomic, readJsonFileSync } from '../persistence/json-file.js';
import { findAllowedRemoteHostRule, getEffectiveTenantRemotePolicy } from '../rag/remote-policy.js';
import { assertPublicRemoteAddress, normalizeRemoteHostname } from '../rag/remote-url.js';
import { securityAuditLog, type SecurityAuditExportBundle } from './audit-log.js';

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const WHITESPACE = /\s+/g;
const DELIVERY_STORE_VERSION = 1;
const DELIVERY_KEY_ID = 'delivery-v1';
const MAX_DELIVERY_URL_LENGTH = 2048;

type LookupResult = Array<{ address: string; family: number }>;

type SecurityExportDeliveryStatus = 'succeeded' | 'failed' | 'blocked';

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
  requested_at: string;
  completed_at: string;
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
  signature: {
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

type DeliveryTransportResult = {
  statusCode: number;
  bodyText?: string;
  bodyTruncated?: boolean;
  durationMs?: number;
  contentType?: string;
};

type DeliveryStoreSnapshot = {
  version: number;
  updatedAt: string;
  tenants: Record<string, unknown[]>;
};

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

class SecurityExportDeliveryStore {
  private readonly filePath: string;
  private readonly maxRecordsPerTenant: number;
  private readonly deliveries = new Map<string, SecurityExportDeliveryRecord[]>();

  constructor(filePath: string, maxRecordsPerTenant: number) {
    this.filePath = filePath;
    this.maxRecordsPerTenant = Math.max(1, maxRecordsPerTenant);
    this.hydrate();
  }

  list(tenantId: string, limit = 20): SecurityExportDeliveryRecord[] {
    const records = this.deliveries.get(tenantId) ?? [];
    return records.slice(0, Math.max(0, limit));
  }

  async record(record: SecurityExportDeliveryRecord): Promise<void> {
    const current = [...(this.deliveries.get(record.tenant_id) ?? [])];
    current.unshift(record);
    this.deliveries.set(record.tenant_id, current.slice(0, this.maxRecordsPerTenant));
    await this.persist();
  }

  reset(): void {
    this.deliveries.clear();
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
  }

  private async persist(): Promise<void> {
    const tenants: Record<string, SecurityExportDeliveryRecord[]> = {};
    for (const [tenantId, records] of this.deliveries.entries()) {
      tenants[tenantId] = records;
    }

    await writeJsonFileAtomic(this.filePath, {
      version: DELIVERY_STORE_VERSION,
      updatedAt: new Date().toISOString(),
      tenants
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

  const status = candidate.status === 'succeeded' || candidate.status === 'failed' || candidate.status === 'blocked'
    ? candidate.status
    : null;

  if (!status) {
    return null;
  }

  return {
    delivery_id: sanitizeString(candidate.delivery_id, 96),
    tenant_id: sanitizeString(candidate.tenant_id, 128),
    request_id: candidate.request_id ? sanitizeString(candidate.request_id, 96) : undefined,
    requested_at: new Date(Date.parse(String(candidate.requested_at ?? Date.now()))).toISOString(),
    completed_at: new Date(Date.parse(String(candidate.completed_at ?? Date.now()))).toISOString(),
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
    signature: {
      key_id: sanitizeString(candidate.signature?.key_id ?? DELIVERY_KEY_ID, 32),
      timestamp: new Date(Date.parse(String(candidate.signature?.timestamp ?? Date.now()))).toISOString(),
      nonce: sanitizeString(candidate.signature?.nonce ?? crypto.randomUUID(), 96),
      body_sha256: sanitizeString(candidate.signature?.body_sha256 ?? '', 96)
    }
  };
}

function normalizeDeliveryPort(url: URL): number {
  const port = url.port ? Number(url.port) : 443;
  return Number.isInteger(port) && port > 0 ? port : 443;
}

function deriveDeliverySigningKey(tenantId: string): Buffer {
  return crypto.createHmac('sha256', config.security.masterKey).update(`security-export-delivery:${tenantId}`).digest();
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
  const signingInput = [
    DELIVERY_KEY_ID,
    tenantId,
    timestamp,
    nonce,
    destinationUrl.pathname || '/',
    bodySha256,
    bundle.integrity.headChainHash ?? ''
  ].join('\n');
  const signature = crypto.createHmac('sha256', deriveDeliverySigningKey(tenantId)).update(signingInput).digest('base64');

  return {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-digest': `sha-256=:${bodyDigest}:`,
      'user-agent': config.security.exportDeliveryUserAgent,
      'x-smart-ai-delivery-id': deliveryId,
      'x-smart-ai-tenant-id': tenantId,
      'x-smart-ai-head-chain-hash': bundle.integrity.headChainHash ?? '',
      'x-smart-ai-event-count': String(bundle.data.length),
      'x-smart-ai-signature': `v1=${signature}`,
      'x-smart-ai-signature-input': `keyid="${DELIVERY_KEY_ID}",created="${timestamp}",nonce="${nonce}",body-sha-256="${bodySha256}"`
    },
    signature: {
      key_id: DELIVERY_KEY_ID,
      timestamp,
      nonce,
      body_sha256: bodySha256
    }
  };
}

function buildErrorRecord(
  options: {
    tenantId: string;
    requestId?: string;
    deliveryId: string;
    requestedAt: string;
    status: SecurityExportDeliveryStatus;
    destination: DeliveryDestination;
    bundle: SecurityAuditExportBundle;
    signature: SecurityExportDeliveryRecord['signature'];
    failureCode: string;
    failureReason: string;
    httpStatus?: number;
    durationMs?: number;
    responseExcerpt?: string;
    responseExcerptTruncated?: boolean;
    pinnedAddress?: string;
    pinnedAddressFamily?: number;
  }
): SecurityExportDeliveryRecord {
  return {
    delivery_id: options.deliveryId,
    tenant_id: options.tenantId,
    request_id: options.requestId,
    requested_at: options.requestedAt,
    completed_at: new Date().toISOString(),
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
    signature: options.signature
  };
}

function buildSuccessRecord(
  options: {
    tenantId: string;
    requestId?: string;
    deliveryId: string;
    requestedAt: string;
    destination: DeliveryDestination;
    bundle: SecurityAuditExportBundle;
    signature: SecurityExportDeliveryRecord['signature'];
    httpStatus: number;
    durationMs: number;
    responseExcerpt?: string;
    responseExcerptTruncated?: boolean;
    pinnedAddress: string;
    pinnedAddressFamily: number;
  }
): SecurityExportDeliveryRecord {
  return {
    delivery_id: options.deliveryId,
    tenant_id: options.tenantId,
    request_id: options.requestId,
    requested_at: options.requestedAt,
    completed_at: new Date().toISOString(),
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
const deliveryStore = new SecurityExportDeliveryStore(
  config.storage.securityExportDeliveryStoreFile,
  config.security.exportDeliveryMaxRecordsPerTenant
);

function getLookup(): (hostname: string) => Promise<LookupResult> {
  return lookupForTests ?? defaultLookup;
}

async function prepareSecurityExportDelivery(options: {
  tenantId: string;
  requestId?: string;
  destinationUrl: string;
  bundle: SecurityAuditExportBundle;
}): Promise<{ prepared: PreparedDelivery; requestedAt: string }> {
  const requestedAt = new Date().toISOString();
  const rawDestinationUrl = String(options.destinationUrl ?? '').trim();
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
  if (family > 0 && !config.security.exportDeliveryAllowIpLiterals) {
    throw new Error('IP-literal delivery targets are disabled. Use a DNS hostname allowlisted in remote policy.');
  }

  if (family === 0 && !hostname.includes('.')) {
    throw new Error('Destination hostname must be a fully-qualified public hostname.');
  }

  const port = normalizeDeliveryPort(parsedUrl);
  if (!config.security.exportDeliveryAllowedPorts.includes(port)) {
    throw new Error(`Destination port ${port} is not allowed for security export delivery.`);
  }

  const policy = await getEffectiveTenantRemotePolicy(options.tenantId);
  const matchedHostRule = findAllowedRemoteHostRule(hostname, policy.allowedHosts);
  if (!matchedHostRule) {
    throw new Error('Destination host is not allowlisted in the tenant remote source policy.');
  }

  const resolved = await getLookup()(hostname);
  const [pinnedAddress] = normalizeLookupResult(hostname, resolved);
  const deliveryId = crypto.randomUUID();
  const payload = JSON.stringify(options.bundle);
  const { headers, signature } = buildSignedHeaders(options.tenantId, deliveryId, parsedUrl, payload, options.bundle);

  return {
    requestedAt,
    prepared: {
      deliveryId,
      target: {
        url: parsedUrl,
        hostname,
        matchedHostRule,
        descriptor: buildDeliveryDestination(parsedUrl, matchedHostRule)
      },
      payload,
      headers,
      pinnedAddress,
      signature
    }
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

function recordSecurityEvent(record: SecurityExportDeliveryRecord): void {
  const eventType =
    record.status === 'succeeded'
      ? 'security_export_delivered'
      : record.status === 'blocked'
        ? 'security_export_delivery_blocked'
        : 'security_export_delivery_failed';

  securityAuditLog.record({
    tenant_id: record.tenant_id,
    type: eventType,
    request_id: record.request_id,
    details: {
      destination_host: record.destination.host,
      matched_host_rule: record.destination.matched_host_rule ?? 'none',
      http_status: record.http_status ?? 0,
      event_count: record.event_count,
      failure_code: record.failure_code ?? 'none',
      head_chain_hash: record.head_chain_hash ?? 'none'
    }
  });
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
        requestedAt,
        status: 'failed',
        destination: prepared.target.descriptor,
        bundle: options.bundle,
        signature: prepared.signature,
        failureCode: 'upstream_rejected',
        failureReason: `Destination responded with HTTP ${result.statusCode}.`,
        httpStatus: result.statusCode,
        durationMs: result.durationMs,
        responseExcerpt,
        responseExcerptTruncated: result.bodyTruncated,
        pinnedAddress: prepared.pinnedAddress.address,
        pinnedAddressFamily: prepared.pinnedAddress.family
      });
      await deliveryStore.record(failedRecord);
      recordSecurityEvent(failedRecord);
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
      requestedAt,
      destination: prepared.target.descriptor,
      bundle: options.bundle,
      signature: prepared.signature,
      httpStatus: result.statusCode,
      durationMs: result.durationMs ?? 0,
      responseExcerpt,
      responseExcerptTruncated: result.bodyTruncated,
      pinnedAddress: prepared.pinnedAddress.address,
      pinnedAddressFamily: prepared.pinnedAddress.family
    });
    await deliveryStore.record(successRecord);
    recordSecurityEvent(successRecord);
    return successRecord;
  } catch (error) {
    if (error instanceof SecurityExportDeliveryError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : 'Security export delivery failed.';
    const blocked = /allowlist|https|credential|invalid|disabled|hostname|port/i.test(message);
    const deliveryId = prepared?.deliveryId ?? crypto.randomUUID();
    const signature =
      prepared?.signature ?? {
        key_id: DELIVERY_KEY_ID,
        timestamp: new Date().toISOString(),
        nonce: crypto.randomUUID(),
        body_sha256: crypto.createHash('sha256').update(JSON.stringify(options.bundle)).digest('hex')
      };
    const destination = prepared?.target.descriptor ?? (() => {
      try {
        const url = new URL(String(options.destinationUrl ?? 'https://invalid.invalid/'));
        const hostname = normalizeRemoteHostname(url.hostname) || 'invalid';
        return buildDeliveryDestination(url, null);
      } catch {
        return {
          origin: 'invalid://invalid',
          host: 'invalid',
          port: 443,
          matched_host_rule: null,
          path_hint: '/',
          path_hash: crypto.createHash('sha256').update('/').digest('hex').slice(0, 16)
        } satisfies DeliveryDestination;
      }
    })();

    const record = buildErrorRecord({
      tenantId: options.tenantId,
      requestId: options.requestId,
      deliveryId,
      requestedAt,
      status: blocked ? 'blocked' : 'failed',
      destination,
      bundle: options.bundle,
      signature,
      failureCode: blocked ? 'policy_blocked' : 'delivery_failed',
      failureReason: message,
      pinnedAddress: prepared?.pinnedAddress.address,
      pinnedAddressFamily: prepared?.pinnedAddress.family
    });

    await deliveryStore.record(record);
    recordSecurityEvent(record);
    throw new SecurityExportDeliveryError(message, {
      code: blocked ? 'policy_blocked' : 'delivery_failed',
      statusCode: blocked ? 403 : 502,
      record
    });
  }
}

export function listSecurityExportDeliveries(tenantId: string, limit = 20): SecurityExportDeliveryRecord[] {
  return deliveryStore.list(tenantId, limit);
}

export const __private__ = {
  prepareSecurityExportDelivery,
  resetStoreForTests() {
    deliveryStore.reset();
  },
  setLookupForTests(lookup?: (hostname: string) => Promise<LookupResult>) {
    lookupForTests = lookup;
  },
  setTransportForTests(transport?: (prepared: PreparedDelivery) => Promise<DeliveryTransportResult>) {
    transportForTests = transport;
  }
};

export { SecurityExportDeliveryError };
