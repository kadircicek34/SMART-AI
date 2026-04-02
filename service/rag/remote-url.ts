import http from 'node:http';
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { domainToASCII } from 'node:url';
import { config } from '../config.js';

const IPV4_SEGMENT_MAX = 255;
const IPV6_TOTAL_GROUPS = 8;
const IPV6_GROUP_BITS = 16n;
const IPV6_MAX_GROUP = 0xffff;
const HTML_TITLE_REGEX = /<title[^>]*>([\s\S]{1,500})<\/title>/i;
const DEFAULT_GLOBAL_FETCH = globalThis.fetch;

type RemoteUrlErrorDetails = Record<string, string | number | boolean | null>;
type LookupImpl = typeof dns.lookup;

type ResolvedAddress = {
  address: string;
  family: number;
};

type RemoteTransportHeaders = Record<string, string | string[] | undefined>;

type RemotePinnedRequest = {
  url: URL;
  headers: Record<string, string>;
  pinnedAddress: ResolvedAddress;
  timeoutMs: number;
  maxBytes: number;
};

type RemoteTransportResult = {
  statusCode: number;
  headers: RemoteTransportHeaders;
  bodyText: string;
  byteCount: number;
};

type RemoteRequestImpl = (request: RemotePinnedRequest) => Promise<RemoteTransportResult>;

export type RemoteUrlInspection = {
  normalizedUrl: string;
  finalUrl: string;
  redirects: string[];
  statusCode: number;
  contentType: string;
  contentLengthBytes: number;
  title?: string;
  text: string;
  excerpt: string;
  snippet: string;
  excerptTruncated: boolean;
};

export class RemoteUrlError extends Error {
  readonly statusCode: number;
  readonly details?: RemoteUrlErrorDetails;
  readonly code: string;

  constructor(code: string, statusCode = 400, details?: RemoteUrlErrorDetails) {
    super(code);
    this.name = 'RemoteUrlError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export { RemoteUrlError as RemoteUrlFetchError };

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripHtml(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  );
}

function extractHtmlTitle(value: string): string | undefined {
  const match = value.match(HTML_TITLE_REGEX)?.[1];
  if (!match) return undefined;
  const title = stripHtml(match).slice(0, 200);
  return title || undefined;
}

export function normalizeRemoteHostname(hostname: string): string {
  const stripped = hostname.replace(/^\[/, '').replace(/\]$/, '').split('%')[0]!.trim().replace(/\.$/, '');
  if (!stripped) {
    return '';
  }

  const lower = stripped.toLowerCase();
  if (net.isIP(lower)) {
    return lower;
  }

  const ascii = domainToASCII(lower);
  return ascii.trim().toLowerCase().replace(/\.$/, '');
}

function extractMimeType(contentTypeHeader: string | null): string {
  return String(contentTypeHeader ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

function isAllowedContentType(contentTypeHeader: string | null): boolean {
  const mime = extractMimeType(contentTypeHeader);
  if (!mime) return false;

  return config.rag.remoteAllowedContentTypes.some((entry) => {
    const candidate = entry.toLowerCase();
    if (candidate === mime) return true;
    if (candidate.endsWith('/*')) {
      return mime.startsWith(candidate.slice(0, -1));
    }
    return false;
  });
}

function isUnsafeHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa')
  );
}

function resolvedPort(url: URL): number {
  if (url.port) {
    return Number(url.port);
  }

  return url.protocol === 'https:' ? 443 : 80;
}

function validateUrlShape(url: URL): void {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new RemoteUrlError('invalid_url_protocol', 400, {
      protocol: url.protocol
    });
  }

  if (url.username || url.password) {
    throw new RemoteUrlError('remote_url_credentials_not_allowed', 400);
  }

  const hostname = normalizeRemoteHostname(url.hostname);
  if (!hostname) {
    throw new RemoteUrlError('invalid_url', 400);
  }

  if (isUnsafeHostname(hostname)) {
    throw new RemoteUrlError('remote_url_private_network_not_allowed', 400, {
      hostname,
      reason: 'localhost_or_internal_hostname'
    });
  }

  const port = resolvedPort(url);
  if (!Number.isInteger(port) || port <= 0 || !config.rag.remoteAllowedPorts.includes(port)) {
    throw new RemoteUrlError('remote_url_port_not_allowed', 400, {
      port
    });
  }
}

function parseIpv4(input: string): number | null {
  const segments = input.split('.');
  if (segments.length !== 4) return null;

  let result = 0;
  for (const segment of segments) {
    if (!/^\d{1,3}$/.test(segment)) {
      return null;
    }

    const value = Number(segment);
    if (!Number.isInteger(value) || value < 0 || value > IPV4_SEGMENT_MAX) {
      return null;
    }

    result = (result << 8) + value;
  }

  return result >>> 0;
}

function ipv4Range(start: string, end: string): [number, number] {
  const startValue = parseIpv4(start);
  const endValue = parseIpv4(end);
  if (startValue === null || endValue === null) {
    throw new Error('invalid_ipv4_range');
  }

  return [startValue, endValue];
}

const IPV4_SPECIAL_RANGES = [
  ipv4Range('0.0.0.0', '0.255.255.255'),
  ipv4Range('10.0.0.0', '10.255.255.255'),
  ipv4Range('100.64.0.0', '100.127.255.255'),
  ipv4Range('127.0.0.0', '127.255.255.255'),
  ipv4Range('169.254.0.0', '169.254.255.255'),
  ipv4Range('172.16.0.0', '172.31.255.255'),
  ipv4Range('192.0.0.0', '192.0.0.255'),
  ipv4Range('192.0.2.0', '192.0.2.255'),
  ipv4Range('192.168.0.0', '192.168.255.255'),
  ipv4Range('198.18.0.0', '198.19.255.255'),
  ipv4Range('198.51.100.0', '198.51.100.255'),
  ipv4Range('203.0.113.0', '203.0.113.255'),
  ipv4Range('224.0.0.0', '255.255.255.255')
] as const;

function isSpecialIpv4(address: string): boolean {
  const value = parseIpv4(address);
  if (value === null) return false;

  return IPV4_SPECIAL_RANGES.some(([start, end]) => value >= start && value <= end);
}

function parseIpv6(input: string): bigint | null {
  const normalized = normalizeRemoteHostname(input);
  const mappedMatch = normalized.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedMatch) {
    const ipv4Value = parseIpv4(mappedMatch[2]!);
    if (ipv4Value === null) return null;

    const hex1 = ((ipv4Value >>> 16) & IPV6_MAX_GROUP).toString(16);
    const hex2 = (ipv4Value & IPV6_MAX_GROUP).toString(16);
    return parseIpv6(`${mappedMatch[1]}${hex1}:${hex2}`);
  }

  const parts = normalized.split('::');
  if (parts.length > 2) return null;

  const left = parts[0] ? parts[0].split(':').filter(Boolean) : [];
  const right = parts[1] ? parts[1].split(':').filter(Boolean) : [];

  if (parts.length === 1 && left.length !== IPV6_TOTAL_GROUPS) {
    return null;
  }

  const missingGroups = IPV6_TOTAL_GROUPS - (left.length + right.length);
  if (missingGroups < 0 || (parts.length === 1 && missingGroups !== 0)) {
    return null;
  }

  const groups = [...left, ...Array.from({ length: missingGroups }, () => '0'), ...right];
  if (groups.length !== IPV6_TOTAL_GROUPS) {
    return null;
  }

  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) {
      return null;
    }

    const value = BigInt(`0x${group}`);
    result = (result << IPV6_GROUP_BITS) + value;
  }

  return result;
}

function ipv6Range(start: string, end: string): [bigint, bigint] {
  const startValue = parseIpv6(start);
  const endValue = parseIpv6(end);
  if (startValue === null || endValue === null) {
    throw new Error('invalid_ipv6_range');
  }

  return [startValue, endValue];
}

const IPV6_SPECIAL_RANGES = [
  ipv6Range('::', '::'),
  ipv6Range('::1', '::1'),
  ipv6Range('fc00::', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'),
  ipv6Range('fe80::', 'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff'),
  ipv6Range('fec0::', 'feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'),
  ipv6Range('ff00::', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'),
  ipv6Range('2001:db8::', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff')
] as const;

function isSpecialIpv6(address: string): boolean {
  const value = parseIpv6(address);
  if (value === null) return false;

  return IPV6_SPECIAL_RANGES.some(([start, end]) => value >= start && value <= end);
}

export function assertPublicRemoteAddress(address: string): void {
  const normalized = normalizeRemoteHostname(address);
  const family = net.isIP(normalized);

  if (family === 4 && isSpecialIpv4(normalized)) {
    throw new RemoteUrlError('remote_url_private_network_not_allowed', 400, {
      address: normalized,
      family,
      reason: 'non_public_ipv4'
    });
  }

  if (family === 6 && isSpecialIpv6(normalized)) {
    throw new RemoteUrlError('remote_url_private_network_not_allowed', 400, {
      address: normalized,
      family,
      reason: 'non_public_ipv6'
    });
  }
}

async function resolveHostname(url: URL, lookupImpl: LookupImpl): Promise<ResolvedAddress[]> {
  const hostname = normalizeRemoteHostname(url.hostname);
  const ipFamily = net.isIP(hostname);
  if (ipFamily) {
    assertPublicRemoteAddress(hostname);
    return [{ address: hostname, family: ipFamily }];
  }

  let records: ResolvedAddress[];
  try {
    const resolved = (await lookupImpl(hostname, { all: true, verbatim: true })) as Array<{
      address: string;
      family: number;
    }>;
    records = resolved.map((entry) => ({
      address: normalizeRemoteHostname(entry.address),
      family: entry.family
    }));
  } catch {
    throw new RemoteUrlError('remote_url_dns_resolution_failed', 400, {
      hostname
    });
  }

  if (records.length === 0) {
    throw new RemoteUrlError('remote_url_dns_resolution_failed', 400, {
      hostname
    });
  }

  for (const record of records) {
    assertPublicRemoteAddress(record.address);
  }

  return records;
}

function buildAcceptHeader(): string {
  return config.rag.remoteAllowedContentTypes.join(', ');
}

function buildRequestHeaders(): Record<string, string> {
  return {
    accept: buildAcceptHeader(),
    'user-agent': config.rag.remoteUserAgent
  };
}

function buildFetchOptions(): RequestInit {
  return {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(config.rag.remoteFetchTimeoutMs),
    headers: buildRequestHeaders()
  };
}

function normalizeHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value.find((entry) => typeof entry === 'string' && entry.trim().length > 0)?.trim() ?? null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function getHeader(headers: RemoteTransportHeaders, name: string): string | null {
  return normalizeHeaderValue(headers[name.toLowerCase()]);
}

async function defaultPinnedRequest(request: RemotePinnedRequest): Promise<RemoteTransportResult> {
  const transport = request.url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      callback();
    };

    const req = transport.request(
      {
        protocol: request.url.protocol,
        hostname: request.url.hostname,
        port: resolvedPort(request.url),
        path: `${request.url.pathname || '/'}${request.url.search || ''}`,
        method: 'GET',
        timeout: request.timeoutMs,
        headers: request.headers,
        lookup: (_hostname, _options, callback) => {
          callback(null, request.pinnedAddress.address, request.pinnedAddress.family);
        }
      },
      (response) => {
        if (isRedirectStatus(response.statusCode ?? 0)) {
          response.resume();
          finish(() =>
            resolve({
              statusCode: response.statusCode ?? 0,
              headers: response.headers,
              bodyText: '',
              byteCount: 0
            })
          );
          return;
        }

        const declaredLength = Number(getHeader(response.headers, 'content-length') ?? '');
        if (Number.isFinite(declaredLength) && declaredLength > request.maxBytes) {
          response.resume();
          req.destroy(
            new RemoteUrlError('remote_url_response_too_large', 413, {
              max_bytes: request.maxBytes,
              content_length: declaredLength
            })
          );
          return;
        }

        const buffers: Buffer[] = [];
        let byteCount = 0;

        response.on('data', (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          byteCount += buffer.length;

          if (byteCount > request.maxBytes) {
            response.destroy(
              new RemoteUrlError('remote_url_response_too_large', 413, {
                max_bytes: request.maxBytes,
                read_bytes: byteCount
              })
            );
            return;
          }

          buffers.push(buffer);
        });

        response.on('error', (error) => {
          finish(() => reject(error));
        });

        response.on('end', () => {
          finish(() =>
            resolve({
              statusCode: response.statusCode ?? 0,
              headers: response.headers,
              bodyText: Buffer.concat(buffers).toString('utf8'),
              byteCount
            })
          );
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new RemoteUrlError('remote_url_fetch_timeout', 504));
    });

    req.on('error', (error) => {
      if (error instanceof RemoteUrlError) {
        finish(() => reject(error));
        return;
      }

      finish(() => reject(new RemoteUrlError('remote_url_fetch_failed', 502, formatUpstreamErrorDetails(error))));
    });

    req.end();
  });
}

async function dispatchPinnedRequest(request: RemotePinnedRequest, requestImpl?: RemoteRequestImpl): Promise<RemoteTransportResult> {
  if (requestImpl) {
    return requestImpl(request);
  }

  return defaultPinnedRequest(request);
}

async function readBody(response: Response, maxBytes: number): Promise<{ bodyText: string; byteCount: number }> {
  const contentLengthHeader = response.headers.get('content-length');
  const declaredLength = Number(contentLengthHeader ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RemoteUrlError('remote_url_response_too_large', 413, {
      max_bytes: maxBytes,
      content_length: declaredLength
    });
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return { bodyText: '', byteCount: 0 };
  }

  const decoder = new TextDecoder();
  let byteCount = 0;
  let bodyText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    byteCount += value.byteLength;
    if (byteCount > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RemoteUrlError('remote_url_response_too_large', 413, {
        max_bytes: maxBytes,
        read_bytes: byteCount
      });
    }

    bodyText += decoder.decode(value, { stream: true });
  }

  bodyText += decoder.decode();

  return {
    bodyText,
    byteCount
  };
}

function formatUpstreamErrorDetails(error: unknown): RemoteUrlErrorDetails {
  if (!(error instanceof Error)) {
    return {
      reason: 'unknown_error'
    };
  }

  return {
    reason: error.name || 'error',
    message: normalizeWhitespace(error.message).slice(0, 180) || 'request failed'
  };
}

function isRedirectStatus(statusCode: number): boolean {
  return statusCode >= 300 && statusCode < 400;
}

function normalizeFetchedText(contentType: string, rawBody: string): string {
  if (contentType.includes('html') || contentType.includes('xml')) {
    return stripHtml(rawBody);
  }

  return normalizeWhitespace(rawBody);
}

export async function inspectRemoteTextSource(params: {
  url: string;
  previewChars?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  requestImpl?: RemoteRequestImpl;
  lookupImpl?: LookupImpl;
}): Promise<RemoteUrlInspection> {
  let initialUrl: URL;
  try {
    initialUrl = new URL(params.url);
  } catch {
    throw new RemoteUrlError('invalid_url', 400);
  }

  const fetchImpl = params.fetchImpl ?? (globalThis.fetch !== DEFAULT_GLOBAL_FETCH ? globalThis.fetch.bind(globalThis) : undefined);
  const lookupImpl = params.lookupImpl ?? dns.lookup.bind(dns);
  const normalizedUrl = initialUrl.toString();
  const previewChars = Math.max(120, params.previewChars ?? config.rag.remotePreviewChars);
  const maxBytes = Math.max(8_192, params.maxBytes ?? config.rag.remoteFetchMaxBytes);

  let currentUrl = initialUrl;
  const redirects: string[] = [];
  const visited = new Set<string>();

  while (true) {
    validateUrlShape(currentUrl);
    const resolvedAddresses = await resolveHostname(currentUrl, lookupImpl);

    const currentUrlString = currentUrl.toString();
    if (visited.has(currentUrlString)) {
      throw new RemoteUrlError('remote_url_redirect_loop_detected', 400, {
        url: currentUrlString
      });
    }
    visited.add(currentUrlString);

    let statusCode = 0;
    let headers: { get(name: string): string | null };
    let bodyText = '';
    let byteCount = 0;

    if (fetchImpl) {
      let response: Response;
      try {
        response = await fetchImpl(currentUrl, buildFetchOptions());
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new RemoteUrlError('remote_url_fetch_timeout', 504);
        }

        throw new RemoteUrlError('remote_url_fetch_failed', 502, formatUpstreamErrorDetails(error));
      }

      statusCode = response.status;
      headers = response.headers;

      if (!isRedirectStatus(statusCode)) {
        const body = await readBody(response, maxBytes);
        bodyText = body.bodyText;
        byteCount = body.byteCount;
      }
    } else {
      let result: RemoteTransportResult;
      try {
        result = await dispatchPinnedRequest(
          {
            url: currentUrl,
            headers: buildRequestHeaders(),
            pinnedAddress: resolvedAddresses[0]!,
            timeoutMs: config.rag.remoteFetchTimeoutMs,
            maxBytes
          },
          params.requestImpl
        );
      } catch (error) {
        if (error instanceof RemoteUrlError) {
          throw error;
        }

        throw new RemoteUrlError('remote_url_fetch_failed', 502, formatUpstreamErrorDetails(error));
      }

      statusCode = result.statusCode;
      headers = {
        get(name: string) {
          return getHeader(result.headers, name);
        }
      };
      bodyText = result.bodyText;
      byteCount = result.byteCount;
    }

    if (isRedirectStatus(statusCode)) {
      const locationHeader = headers.get('location');
      if (!locationHeader) {
        throw new RemoteUrlError('remote_url_redirect_missing_location', 502, {
          status: statusCode
        });
      }

      if (redirects.length >= config.rag.remoteFetchMaxRedirects) {
        throw new RemoteUrlError('remote_url_too_many_redirects', 400, {
          max_redirects: config.rag.remoteFetchMaxRedirects
        });
      }

      let nextUrl: URL;
      try {
        nextUrl = new URL(locationHeader, currentUrl);
      } catch {
        throw new RemoteUrlError('remote_url_redirect_invalid', 400);
      }

      redirects.push(nextUrl.toString());
      currentUrl = nextUrl;
      continue;
    }

    if (statusCode < 200 || statusCode >= 300) {
      throw new RemoteUrlError(`remote_url_fetch_failed_${statusCode}`, 502, {
        status: statusCode
      });
    }

    const contentType = extractMimeType(headers.get('content-type'));
    if (!isAllowedContentType(contentType)) {
      throw new RemoteUrlError('remote_url_content_type_not_allowed', 415, {
        content_type: contentType || 'unknown'
      });
    }

    const text = normalizeFetchedText(contentType, bodyText);
    if (!text) {
      throw new RemoteUrlError('remote_url_empty_content', 422, {
        content_type: contentType || 'unknown'
      });
    }

    const excerpt = text.slice(0, previewChars);
    return {
      normalizedUrl,
      finalUrl: currentUrl.toString(),
      redirects,
      statusCode,
      contentType,
      contentLengthBytes: byteCount,
      title: contentType.includes('html') ? extractHtmlTitle(bodyText) : undefined,
      text,
      excerpt,
      snippet: excerpt,
      excerptTruncated: text.length > excerpt.length
    };
  }
}

export async function inspectRemoteUrl(params: {
  url: string;
  previewChars?: number;
  maxBytes?: number;
}): Promise<RemoteUrlInspection> {
  return inspectRemoteTextSource(params);
}
