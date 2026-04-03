import net from 'node:net';
import { config } from '../config.js';
import { readJsonFileSync, writeJsonFileAtomic } from '../persistence/json-file.js';
import {
  findAllowedRemoteHostRule,
  getEffectiveTenantRemotePolicy,
  normalizeAllowedHostRule
} from '../rag/remote-policy.js';

export const SECURITY_EXPORT_DELIVERY_POLICY_MODES = ['inherit_remote_policy', 'disabled', 'allowlist_only'] as const;

export type SecurityExportDeliveryPolicyMode = (typeof SECURITY_EXPORT_DELIVERY_POLICY_MODES)[number];

export type TenantSecurityExportDeliveryPolicyInput = {
  mode: SecurityExportDeliveryPolicyMode;
  allowedTargets: string[];
};

export type StoredTenantSecurityExportDeliveryPolicy = TenantSecurityExportDeliveryPolicyInput & {
  updatedAt: string;
};

type SecurityExportDeliveryPolicyFile = {
  tenants: Record<string, StoredTenantSecurityExportDeliveryPolicy>;
};

export type EffectiveSecurityExportDeliveryPolicy = {
  tenantId: string;
  source: 'deployment' | 'tenant';
  policyStatus: 'inherited' | 'active';
  mode: SecurityExportDeliveryPolicyMode;
  allowedTargets: string[];
  deploymentDefaultMode: SecurityExportDeliveryPolicyMode;
  deploymentDefaultAllowedTargets: string[];
  updatedAt: string | null;
};

export type SecurityExportDeliveryTargetPolicyReason =
  | 'policy_disabled'
  | 'allowlist_match'
  | 'host_not_in_allowlist'
  | 'path_not_in_allowlist'
  | 'inherit_remote_policy_match'
  | 'inherit_remote_policy_host_not_in_allowlist';

export type SecurityExportDeliveryTargetPolicyDecision = {
  policy: EffectiveSecurityExportDeliveryPolicy;
  hostname: string;
  port: number;
  path: string;
  matchedRule: string | null;
  allowed: boolean;
  reason: SecurityExportDeliveryTargetPolicyReason;
};

type NormalizedAllowedTargetRule = {
  hostRule: string;
  port: number | null;
  pathPrefix: string;
  normalized: string;
};

function isSecurityExportDeliveryPolicyMode(value: string): value is SecurityExportDeliveryPolicyMode {
  return SECURITY_EXPORT_DELIVERY_POLICY_MODES.includes(value as SecurityExportDeliveryPolicyMode);
}

function normalizeMode(value: string | undefined): SecurityExportDeliveryPolicyMode {
  const normalized = String(value ?? '').trim().toLowerCase();
  return isSecurityExportDeliveryPolicyMode(normalized)
    ? normalized
    : (config.security.exportDeliveryPolicyDefaultMode as SecurityExportDeliveryPolicyMode);
}

function normalizePort(value: string | number | undefined): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('allowed_target_port_invalid');
  }

  if (!config.security.exportDeliveryAllowedPorts.includes(parsed)) {
    throw new Error('allowed_target_port_not_allowed');
  }

  return parsed;
}

function normalizePathPrefix(raw: string | undefined): string {
  const candidate = String(raw ?? '').trim();
  if (!candidate || candidate === '/') {
    return '/';
  }

  if (/\s/.test(candidate) || candidate.includes('?') || candidate.includes('#')) {
    throw new Error('allowed_target_path_must_not_include_query_or_fragment');
  }

  const prefixed = candidate.startsWith('/') ? candidate : `/${candidate}`;
  const compacted = prefixed.replace(/\/{2,}/g, '/');
  if (compacted === '/') {
    return '/';
  }

  const withoutTrailingSlash = compacted.endsWith('/') ? compacted.slice(0, -1) : compacted;
  return withoutTrailingSlash || '/';
}

function buildNormalizedAllowedTargetRule(rule: Omit<NormalizedAllowedTargetRule, 'normalized'>): NormalizedAllowedTargetRule {
  return {
    ...rule,
    normalized: `${rule.hostRule}${rule.port ? `:${rule.port}` : ''}${rule.pathPrefix === '/' ? '' : rule.pathPrefix}`
  };
}

function splitHostAndPort(raw: string): { hostPart: string; port: number | null } {
  const candidate = String(raw ?? '').trim();
  if (!candidate) {
    throw new Error('allowed_target_required');
  }

  if (/\s/.test(candidate) || candidate.includes('@')) {
    throw new Error('allowed_target_host_invalid');
  }

  if (candidate.startsWith('[') || candidate.endsWith(']')) {
    throw new Error('allowed_target_bracketed_ipv6_requires_https_url_format');
  }

  if (net.isIP(candidate) === 6) {
    return { hostPart: candidate, port: null };
  }

  const colonCount = candidate.split(':').length - 1;
  if (colonCount === 0) {
    return { hostPart: candidate, port: null };
  }

  if (colonCount > 1) {
    throw new Error('allowed_target_ipv6_requires_https_url_format');
  }

  const lastColonIndex = candidate.lastIndexOf(':');
  const hostPart = candidate.slice(0, lastColonIndex).trim();
  const portPart = candidate.slice(lastColonIndex + 1).trim();
  if (!hostPart || !portPart) {
    throw new Error('allowed_target_host_invalid');
  }

  return {
    hostPart,
    port: normalizePort(portPart)
  };
}

function parseAllowedTargetRule(raw: string): NormalizedAllowedTargetRule {
  const candidate = String(raw ?? '').trim();
  if (!candidate) {
    throw new Error('allowed_target_required');
  }

  if (candidate.includes('://')) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(candidate);
    } catch {
      throw new Error('allowed_target_invalid_url');
    }

    if (parsedUrl.protocol !== 'https:') {
      throw new Error('allowed_target_requires_https');
    }

    if (parsedUrl.username || parsedUrl.password) {
      throw new Error('allowed_target_must_not_include_credentials');
    }

    if (parsedUrl.search || parsedUrl.hash) {
      throw new Error('allowed_target_must_not_include_query_or_fragment');
    }

    return buildNormalizedAllowedTargetRule({
      hostRule: normalizeAllowedHostRule(parsedUrl.hostname),
      port: normalizePort(parsedUrl.port || undefined),
      pathPrefix: normalizePathPrefix(parsedUrl.pathname || '/')
    });
  }

  if (candidate.includes('?') || candidate.includes('#')) {
    throw new Error('allowed_target_must_not_include_query_or_fragment');
  }

  const slashIndex = candidate.indexOf('/');
  const hostPortPart = slashIndex >= 0 ? candidate.slice(0, slashIndex) : candidate;
  const pathPrefix = slashIndex >= 0 ? candidate.slice(slashIndex) : '/';
  const { hostPart, port } = splitHostAndPort(hostPortPart);

  return buildNormalizedAllowedTargetRule({
    hostRule: normalizeAllowedHostRule(hostPart),
    port,
    pathPrefix: normalizePathPrefix(pathPrefix)
  });
}

function dedupeAllowedTargets(input: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const raw of input) {
    const value = parseAllowedTargetRule(raw).normalized;
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

function normalizeDeploymentDefaultAllowedTargets(): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const raw of config.security.exportDeliveryPolicyDefaultAllowedTargets) {
    try {
      const value = parseAllowedTargetRule(raw).normalized;
      if (seen.has(value)) {
        continue;
      }

      seen.add(value);
      normalized.push(value);
    } catch {
      // Fail-closed: ignore invalid deployment defaults rather than widening access.
    }
  }

  return normalized;
}

function readStore(): SecurityExportDeliveryPolicyFile {
  const parsed = readJsonFileSync<SecurityExportDeliveryPolicyFile>(config.storage.securityExportDeliveryPolicyFile);
  return parsed?.tenants && typeof parsed.tenants === 'object' ? { tenants: parsed.tenants } : { tenants: {} };
}

async function writeStore(store: SecurityExportDeliveryPolicyFile): Promise<void> {
  await writeJsonFileAtomic(config.storage.securityExportDeliveryPolicyFile, store);
}

function sanitizeStoredTenantPolicy(value: unknown): StoredTenantSecurityExportDeliveryPolicy | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<StoredTenantSecurityExportDeliveryPolicy>;
  const validated = validateTenantSecurityExportDeliveryPolicyInput({
    mode: normalizeMode(candidate.mode),
    allowedTargets: Array.isArray(candidate.allowedTargets) ? candidate.allowedTargets.map((entry) => String(entry)) : []
  });

  if (!validated.ok) {
    return null;
  }

  const updatedAt = String(candidate.updatedAt ?? '').trim();
  const parsedUpdatedAt = Date.parse(updatedAt);

  return {
    ...validated.value,
    updatedAt: Number.isFinite(parsedUpdatedAt) ? new Date(parsedUpdatedAt).toISOString() : new Date().toISOString()
  };
}

export function validateTenantSecurityExportDeliveryPolicyInput(
  input: TenantSecurityExportDeliveryPolicyInput
):
  | { ok: true; value: TenantSecurityExportDeliveryPolicyInput }
  | { ok: false; reason: string; code: string; statusCode: number } {
  const mode = normalizeMode(input.mode);
  if (!isSecurityExportDeliveryPolicyMode(mode)) {
    return {
      ok: false,
      reason: 'Invalid security export delivery policy mode.',
      code: 'invalid_mode',
      statusCode: 400
    };
  }

  let allowedTargets: string[];
  try {
    allowedTargets = dedupeAllowedTargets(Array.isArray(input.allowedTargets) ? input.allowedTargets : []);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Invalid allowed target entry.',
      code: 'invalid_allowed_target',
      statusCode: 400
    };
  }

  const maxAllowedTargets = Math.max(0, config.security.exportDeliveryPolicyMaxAllowedTargets);
  if (allowedTargets.length > maxAllowedTargets) {
    return {
      ok: false,
      reason: `Too many allowed delivery targets requested for this tenant (max ${maxAllowedTargets}).`,
      code: 'too_many_allowed_targets',
      statusCode: 400
    };
  }

  if (mode === 'allowlist_only' && allowedTargets.length === 0) {
    return {
      ok: false,
      reason: 'allowlist_only mode requires at least one allowed delivery target.',
      code: 'allowed_targets_required',
      statusCode: 400
    };
  }

  return {
    ok: true,
    value: {
      mode,
      allowedTargets
    }
  };
}

export async function getTenantSecurityExportDeliveryPolicy(
  tenantId: string
): Promise<StoredTenantSecurityExportDeliveryPolicy | null> {
  const store = readStore();
  return sanitizeStoredTenantPolicy(store.tenants[tenantId]);
}

export async function setTenantSecurityExportDeliveryPolicy(
  tenantId: string,
  input: TenantSecurityExportDeliveryPolicyInput
): Promise<
  | { ok: true; policy: StoredTenantSecurityExportDeliveryPolicy }
  | { ok: false; reason: string; code: string; statusCode: number }
> {
  const validated = validateTenantSecurityExportDeliveryPolicyInput(input);
  if (!validated.ok) {
    return validated;
  }

  const store = readStore();
  const policy: StoredTenantSecurityExportDeliveryPolicy = {
    ...validated.value,
    updatedAt: new Date().toISOString()
  };

  store.tenants[tenantId] = policy;
  await writeStore(store);

  return {
    ok: true,
    policy
  };
}

export async function resetTenantSecurityExportDeliveryPolicy(tenantId: string): Promise<boolean> {
  const store = readStore();
  const existed = Boolean(store.tenants[tenantId]);

  if (existed) {
    delete store.tenants[tenantId];
    await writeStore(store);
  }

  return existed;
}

export async function getEffectiveSecurityExportDeliveryPolicy(
  tenantId: string
): Promise<EffectiveSecurityExportDeliveryPolicy> {
  const deploymentDefaultMode = normalizeMode(config.security.exportDeliveryPolicyDefaultMode);
  const deploymentDefaultAllowedTargets = normalizeDeploymentDefaultAllowedTargets();
  const stored = await getTenantSecurityExportDeliveryPolicy(tenantId);

  if (!stored) {
    return {
      tenantId,
      source: 'deployment',
      policyStatus: 'inherited',
      mode: deploymentDefaultMode,
      allowedTargets: deploymentDefaultAllowedTargets,
      deploymentDefaultMode,
      deploymentDefaultAllowedTargets,
      updatedAt: null
    };
  }

  return {
    tenantId,
    source: 'tenant',
    policyStatus: 'active',
    mode: stored.mode,
    allowedTargets: stored.allowedTargets,
    deploymentDefaultMode,
    deploymentDefaultAllowedTargets,
    updatedAt: stored.updatedAt
  };
}

function matchAllowedHostRule(hostname: string, rule: string): boolean {
  if (rule.startsWith('*.')) {
    const base = rule.slice(2);
    if (!base || net.isIP(hostname)) {
      return false;
    }

    return hostname.length > base.length + 1 && hostname.endsWith(`.${base}`);
  }

  return hostname === rule;
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix === '/') {
    return true;
  }

  if (pathname === prefix) {
    return true;
  }

  return pathname.startsWith(`${prefix}/`);
}

function evaluateAllowedTargetRules(
  hostname: string,
  port: number,
  path: string,
  allowedTargets: string[]
): { matchedRule: string | null; hostMatched: boolean } {
  let hostMatched = false;

  for (const rawRule of allowedTargets) {
    const rule = parseAllowedTargetRule(rawRule);
    if (rule.port !== null && rule.port !== port) {
      continue;
    }

    if (!matchAllowedHostRule(hostname, rule.hostRule)) {
      continue;
    }

    hostMatched = true;
    if (pathMatchesPrefix(path, rule.pathPrefix)) {
      return {
        matchedRule: rule.normalized,
        hostMatched: true
      };
    }
  }

  return {
    matchedRule: null,
    hostMatched
  };
}

export async function evaluateSecurityExportDeliveryTargetPolicy(params: {
  tenantId: string;
  hostname: string;
  port: number;
  path: string;
}): Promise<SecurityExportDeliveryTargetPolicyDecision> {
  const hostname = String(params.hostname ?? '').trim().toLowerCase();
  const port = Number(params.port);
  const path = normalizePathPrefix(params.path || '/');
  const policy = await getEffectiveSecurityExportDeliveryPolicy(params.tenantId);

  if (policy.mode === 'disabled') {
    return {
      policy,
      hostname,
      port,
      path,
      matchedRule: null,
      allowed: false,
      reason: 'policy_disabled'
    };
  }

  if (policy.mode === 'inherit_remote_policy') {
    const remotePolicy = await getEffectiveTenantRemotePolicy(params.tenantId);
    const matchedRule = findAllowedRemoteHostRule(hostname, remotePolicy.allowedHosts);

    return {
      policy,
      hostname,
      port,
      path,
      matchedRule,
      allowed: Boolean(matchedRule),
      reason: matchedRule ? 'inherit_remote_policy_match' : 'inherit_remote_policy_host_not_in_allowlist'
    };
  }

  const evaluated = evaluateAllowedTargetRules(hostname, port, path, policy.allowedTargets);
  return {
    policy,
    hostname,
    port,
    path,
    matchedRule: evaluated.matchedRule,
    allowed: Boolean(evaluated.matchedRule),
    reason: evaluated.matchedRule ? 'allowlist_match' : evaluated.hostMatched ? 'path_not_in_allowlist' : 'host_not_in_allowlist'
  };
}
