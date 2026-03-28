import net from 'node:net';
import { config } from '../config.js';
import { readJsonFileSync, writeJsonFileAtomic } from '../persistence/json-file.js';
import { assertPublicRemoteAddress, normalizeRemoteHostname } from './remote-url.js';

export const REMOTE_SOURCE_POLICY_MODES = ['disabled', 'preview_only', 'allowlist_only', 'open'] as const;

export type RemoteSourcePolicyMode = (typeof REMOTE_SOURCE_POLICY_MODES)[number];

export type TenantRemotePolicyInput = {
  mode: RemoteSourcePolicyMode;
  allowedHosts: string[];
};

export type StoredTenantRemotePolicy = TenantRemotePolicyInput & {
  updatedAt: string;
};

type RemotePolicyFile = {
  tenants: Record<string, StoredTenantRemotePolicy>;
};

export type EffectiveTenantRemotePolicy = {
  tenantId: string;
  source: 'deployment' | 'tenant';
  policyStatus: 'inherited' | 'active';
  mode: RemoteSourcePolicyMode;
  allowedHosts: string[];
  deploymentDefaultMode: RemoteSourcePolicyMode;
  deploymentDefaultAllowedHosts: string[];
  updatedAt: string | null;
};

export type TenantRemoteUrlPolicyDecision = {
  policy: EffectiveTenantRemotePolicy;
  hostname: string;
  matchedHostRule: string | null;
  previewAllowed: boolean;
  ingestAllowed: boolean;
  reason: 'policy_disabled' | 'preview_only_mode' | 'allowlist_match' | 'host_not_in_allowlist' | 'open_mode';
};

function isRemoteSourcePolicyMode(value: string): value is RemoteSourcePolicyMode {
  return REMOTE_SOURCE_POLICY_MODES.includes(value as RemoteSourcePolicyMode);
}

function normalizeMode(value: string | undefined): RemoteSourcePolicyMode {
  const normalized = String(value ?? '').trim().toLowerCase();
  return isRemoteSourcePolicyMode(normalized) ? normalized : 'preview_only';
}

function isUnsafeHostCandidate(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa')
  );
}

function normalizeAllowedHostRule(raw: string): string {
  const candidate = String(raw ?? '').trim();
  if (!candidate) {
    throw new Error('allowed_host_required');
  }

  if (/[/?#\s]/.test(candidate) || candidate.includes('://')) {
    throw new Error('allowed_host_must_not_include_scheme_or_path');
  }

  const wildcard = candidate.startsWith('*.');
  const base = wildcard ? candidate.slice(2) : candidate;
  const normalized = normalizeRemoteHostname(base);

  if (!normalized) {
    throw new Error('allowed_host_invalid');
  }

  if (isUnsafeHostCandidate(normalized)) {
    throw new Error('allowed_host_private_not_allowed');
  }

  const family = net.isIP(normalized);
  if (family > 0) {
    if (wildcard) {
      throw new Error('allowed_host_wildcard_ip_not_supported');
    }

    assertPublicRemoteAddress(normalized);
    return normalized;
  }

  if (!normalized.includes('.')) {
    throw new Error('allowed_host_domain_required');
  }

  if (wildcard) {
    return `*.${normalized}`;
  }

  return normalized;
}

function dedupeAllowedHosts(input: string[]): string[] {
  const deduped = new Set<string>();
  const normalized: string[] = [];

  for (const raw of input) {
    const value = normalizeAllowedHostRule(raw);
    if (deduped.has(value)) {
      continue;
    }

    deduped.add(value);
    normalized.push(value);
  }

  return normalized;
}

function normalizeDeploymentDefaultAllowedHosts(): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const raw of config.rag.remotePolicyDefaultAllowedHosts) {
    try {
      const value = normalizeAllowedHostRule(raw);
      if (seen.has(value)) {
        continue;
      }

      seen.add(value);
      normalized.push(value);
    } catch {
      // fail-safe: ignore invalid deployment defaults rather than widening access
    }
  }

  return normalized;
}

function readStore(): RemotePolicyFile {
  const parsed = readJsonFileSync<RemotePolicyFile>(config.storage.ragRemotePolicyFile);
  return parsed?.tenants && typeof parsed.tenants === 'object' ? { tenants: parsed.tenants } : { tenants: {} };
}

async function writeStore(store: RemotePolicyFile): Promise<void> {
  await writeJsonFileAtomic(config.storage.ragRemotePolicyFile, store);
}

function sanitizeStoredTenantPolicy(value: unknown): StoredTenantRemotePolicy | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<StoredTenantRemotePolicy>;
  const validated = validateTenantRemotePolicyInput({
    mode: normalizeMode(candidate.mode),
    allowedHosts: Array.isArray(candidate.allowedHosts) ? candidate.allowedHosts.map((entry) => String(entry)) : []
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

export function validateTenantRemotePolicyInput(input: TenantRemotePolicyInput):
  | { ok: true; value: TenantRemotePolicyInput }
  | { ok: false; reason: string; code: string; statusCode: number } {
  const mode = normalizeMode(input.mode);
  if (!isRemoteSourcePolicyMode(mode)) {
    return {
      ok: false,
      reason: 'Invalid remote policy mode.',
      code: 'invalid_mode',
      statusCode: 400
    };
  }

  let allowedHosts: string[];
  try {
    allowedHosts = dedupeAllowedHosts(Array.isArray(input.allowedHosts) ? input.allowedHosts : []);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Invalid allowed host entry.',
      code: 'invalid_allowed_host',
      statusCode: 400
    };
  }

  const maxAllowedHosts = Math.max(0, config.rag.remotePolicyMaxAllowedHosts);
  if (allowedHosts.length > maxAllowedHosts) {
    return {
      ok: false,
      reason: `Too many allowed hosts requested for this tenant (max ${maxAllowedHosts}).`,
      code: 'too_many_allowed_hosts',
      statusCode: 400
    };
  }

  return {
    ok: true,
    value: {
      mode,
      allowedHosts
    }
  };
}

export async function getTenantRemotePolicy(tenantId: string): Promise<StoredTenantRemotePolicy | null> {
  const store = readStore();
  return sanitizeStoredTenantPolicy(store.tenants[tenantId]);
}

export async function setTenantRemotePolicy(
  tenantId: string,
  input: TenantRemotePolicyInput
): Promise<
  | { ok: true; policy: StoredTenantRemotePolicy }
  | { ok: false; reason: string; code: string; statusCode: number }
> {
  const validated = validateTenantRemotePolicyInput(input);
  if (!validated.ok) {
    return validated;
  }

  const store = readStore();
  const policy: StoredTenantRemotePolicy = {
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

export async function resetTenantRemotePolicy(tenantId: string): Promise<boolean> {
  const store = readStore();
  const existed = Boolean(store.tenants[tenantId]);

  if (existed) {
    delete store.tenants[tenantId];
    await writeStore(store);
  }

  return existed;
}

export async function getEffectiveTenantRemotePolicy(tenantId: string): Promise<EffectiveTenantRemotePolicy> {
  const deploymentDefaultMode = normalizeMode(config.rag.remotePolicyDefaultMode);
  const deploymentDefaultAllowedHosts = normalizeDeploymentDefaultAllowedHosts();
  const stored = await getTenantRemotePolicy(tenantId);

  if (!stored) {
    return {
      tenantId,
      source: 'deployment',
      policyStatus: 'inherited',
      mode: deploymentDefaultMode,
      allowedHosts: deploymentDefaultAllowedHosts,
      deploymentDefaultMode,
      deploymentDefaultAllowedHosts,
      updatedAt: null
    };
  }

  return {
    tenantId,
    source: 'tenant',
    policyStatus: 'active',
    mode: stored.mode,
    allowedHosts: stored.allowedHosts,
    deploymentDefaultMode,
    deploymentDefaultAllowedHosts,
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

function resolveMatchedHostRule(hostname: string, allowedHosts: string[]): string | null {
  for (const rule of allowedHosts) {
    if (matchAllowedHostRule(hostname, rule)) {
      return rule;
    }
  }

  return null;
}

export async function evaluateTenantRemoteUrlPolicy(
  tenantId: string,
  url: string
): Promise<TenantRemoteUrlPolicyDecision> {
  const policy = await getEffectiveTenantRemotePolicy(tenantId);
  const parsed = new URL(url);
  const hostname = normalizeRemoteHostname(parsed.hostname);
  const matchedHostRule = resolveMatchedHostRule(hostname, policy.allowedHosts);

  if (policy.mode === 'disabled') {
    return {
      policy,
      hostname,
      matchedHostRule,
      previewAllowed: false,
      ingestAllowed: false,
      reason: 'policy_disabled'
    };
  }

  if (policy.mode === 'preview_only') {
    return {
      policy,
      hostname,
      matchedHostRule,
      previewAllowed: true,
      ingestAllowed: false,
      reason: 'preview_only_mode'
    };
  }

  if (policy.mode === 'open') {
    return {
      policy,
      hostname,
      matchedHostRule,
      previewAllowed: true,
      ingestAllowed: true,
      reason: 'open_mode'
    };
  }

  return {
    policy,
    hostname,
    matchedHostRule,
    previewAllowed: true,
    ingestAllowed: Boolean(matchedHostRule),
    reason: matchedHostRule ? 'allowlist_match' : 'host_not_in_allowlist'
  };
}
