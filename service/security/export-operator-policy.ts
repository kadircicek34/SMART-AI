import { config } from '../config.js';
import { readJsonFileSync, writeJsonFileAtomic } from '../persistence/json-file.js';

export const SECURITY_EXPORT_OPERATOR_POLICY_MODES = ['open_admins', 'roster_required'] as const;
export const SECURITY_EXPORT_OPERATOR_POLICY_ACTIONS = ['acknowledge', 'clear_request', 'clear_approve'] as const;

export type SecurityExportOperatorPolicyMode = (typeof SECURITY_EXPORT_OPERATOR_POLICY_MODES)[number];
export type SecurityExportOperatorAction = (typeof SECURITY_EXPORT_OPERATOR_POLICY_ACTIONS)[number];

export type SecurityExportOperatorRoster = Record<SecurityExportOperatorAction, string[]>;

export type TenantSecurityExportOperatorPolicyInput = {
  mode: SecurityExportOperatorPolicyMode;
  roster: SecurityExportOperatorRoster;
};

export type StoredTenantSecurityExportOperatorPolicy = TenantSecurityExportOperatorPolicyInput & {
  updatedAt: string;
};

type SecurityExportOperatorPolicyFile = {
  tenants: Record<string, StoredTenantSecurityExportOperatorPolicy>;
};

export type EffectiveSecurityExportOperatorPolicy = {
  tenantId: string;
  source: 'deployment' | 'tenant';
  policyStatus: 'inherited' | 'active';
  mode: SecurityExportOperatorPolicyMode;
  roster: SecurityExportOperatorRoster;
  deploymentDefaultMode: SecurityExportOperatorPolicyMode;
  deploymentDefaultRoster: SecurityExportOperatorRoster;
  updatedAt: string | null;
};

export type SecurityExportOperatorAuthorizationReason = 'open_admins' | 'role_match' | 'principal_missing' | 'principal_not_in_role';

export type SecurityExportOperatorAuthorizationDecision = {
  allowed: boolean;
  action: SecurityExportOperatorAction;
  principalName: string;
  policy: EffectiveSecurityExportOperatorPolicy;
  reason: SecurityExportOperatorAuthorizationReason;
};

const PRINCIPAL_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

function parseCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isMode(value: string): value is SecurityExportOperatorPolicyMode {
  return SECURITY_EXPORT_OPERATOR_POLICY_MODES.includes(value as SecurityExportOperatorPolicyMode);
}

function normalizeMode(value: string | undefined): SecurityExportOperatorPolicyMode {
  const normalized = String(value ?? '').trim().toLowerCase();
  return isMode(normalized) ? normalized : (config.security.exportOperatorPolicyDefaultMode as SecurityExportOperatorPolicyMode);
}

function emptyRoster(): SecurityExportOperatorRoster {
  return {
    acknowledge: [],
    clear_request: [],
    clear_approve: []
  };
}

function normalizePrincipalName(value: string): string {
  return String(value ?? '').trim();
}

function normalizePrincipalList(input: string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const raw of input ?? []) {
    const principal = normalizePrincipalName(raw);
    if (!principal) {
      continue;
    }

    if (!PRINCIPAL_NAME_REGEX.test(principal)) {
      throw new Error('principal_name_invalid');
    }

    if (seen.has(principal)) {
      continue;
    }

    seen.add(principal);
    normalized.push(principal);
  }

  return normalized;
}

function normalizeRoster(input: Partial<Record<SecurityExportOperatorAction, string[]>> | undefined): SecurityExportOperatorRoster {
  return {
    acknowledge: normalizePrincipalList(input?.acknowledge),
    clear_request: normalizePrincipalList(input?.clear_request),
    clear_approve: normalizePrincipalList(input?.clear_approve)
  };
}

function normalizeDeploymentDefaultRoster(): SecurityExportOperatorRoster {
  try {
    return normalizeRoster({
      acknowledge: parseCsv(process.env.SECURITY_EXPORT_OPERATOR_POLICY_DEFAULT_ACKNOWLEDGERS),
      clear_request: parseCsv(process.env.SECURITY_EXPORT_OPERATOR_POLICY_DEFAULT_CLEAR_REQUESTERS),
      clear_approve: parseCsv(process.env.SECURITY_EXPORT_OPERATOR_POLICY_DEFAULT_CLEAR_APPROVERS)
    });
  } catch {
    return emptyRoster();
  }
}

function readStore(): SecurityExportOperatorPolicyFile {
  const parsed = readJsonFileSync<SecurityExportOperatorPolicyFile>(config.storage.securityExportOperatorPolicyFile);
  return parsed?.tenants && typeof parsed.tenants === 'object' ? { tenants: parsed.tenants } : { tenants: {} };
}

async function writeStore(store: SecurityExportOperatorPolicyFile): Promise<void> {
  await writeJsonFileAtomic(config.storage.securityExportOperatorPolicyFile, store);
}

function sanitizeStoredPolicy(value: unknown): StoredTenantSecurityExportOperatorPolicy | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<StoredTenantSecurityExportOperatorPolicy> & {
    roster?: Partial<Record<SecurityExportOperatorAction, string[]>>;
  };
  const validated = validateTenantSecurityExportOperatorPolicyInput({
    mode: normalizeMode(candidate.mode),
    roster: normalizeRoster(candidate.roster)
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

export function validateTenantSecurityExportOperatorPolicyInput(
  input: TenantSecurityExportOperatorPolicyInput
):
  | { ok: true; value: TenantSecurityExportOperatorPolicyInput }
  | { ok: false; reason: string; code: string; statusCode: number } {
  const mode = normalizeMode(input.mode);
  if (!isMode(mode)) {
    return {
      ok: false,
      reason: 'Invalid security export operator policy mode.',
      code: 'invalid_mode',
      statusCode: 400
    };
  }

  let roster: SecurityExportOperatorRoster;
  try {
    roster = normalizeRoster(input.roster);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Invalid operator principal entry.',
      code: 'invalid_principal_name',
      statusCode: 400
    };
  }

  const maxPrincipalsPerRole = Math.max(1, Math.trunc(config.security.exportOperatorPolicyMaxPrincipalsPerRole));
  for (const action of SECURITY_EXPORT_OPERATOR_POLICY_ACTIONS) {
    if (roster[action].length > maxPrincipalsPerRole) {
      return {
        ok: false,
        reason: `Too many principals configured for ${action} (max ${maxPrincipalsPerRole}).`,
        code: 'too_many_principals',
        statusCode: 400
      };
    }
  }

  if (mode === 'roster_required') {
    for (const action of SECURITY_EXPORT_OPERATOR_POLICY_ACTIONS) {
      if (roster[action].length === 0) {
        return {
          ok: false,
          reason: `roster_required mode requires at least one principal for ${action}.`,
          code: 'principal_required',
          statusCode: 400
        };
      }
    }
  }

  return {
    ok: true,
    value: {
      mode,
      roster
    }
  };
}

export async function getTenantSecurityExportOperatorPolicy(
  tenantId: string
): Promise<StoredTenantSecurityExportOperatorPolicy | null> {
  const store = readStore();
  return sanitizeStoredPolicy(store.tenants[tenantId]);
}

export async function setTenantSecurityExportOperatorPolicy(
  tenantId: string,
  input: TenantSecurityExportOperatorPolicyInput
): Promise<
  | { ok: true; policy: StoredTenantSecurityExportOperatorPolicy }
  | { ok: false; reason: string; code: string; statusCode: number }
> {
  const validated = validateTenantSecurityExportOperatorPolicyInput(input);
  if (!validated.ok) {
    return validated;
  }

  const store = readStore();
  const policy: StoredTenantSecurityExportOperatorPolicy = {
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

export async function resetTenantSecurityExportOperatorPolicy(tenantId: string): Promise<boolean> {
  const store = readStore();
  const existed = Boolean(store.tenants[tenantId]);

  if (existed) {
    delete store.tenants[tenantId];
    await writeStore(store);
  }

  return existed;
}

export async function getEffectiveSecurityExportOperatorPolicy(
  tenantId: string
): Promise<EffectiveSecurityExportOperatorPolicy> {
  const deploymentDefaultMode = normalizeMode(config.security.exportOperatorPolicyDefaultMode);
  const deploymentDefaultRoster = normalizeDeploymentDefaultRoster();
  const stored = await getTenantSecurityExportOperatorPolicy(tenantId);

  if (!stored) {
    return {
      tenantId,
      source: 'deployment',
      policyStatus: 'inherited',
      mode: deploymentDefaultMode,
      roster: deploymentDefaultRoster,
      deploymentDefaultMode,
      deploymentDefaultRoster,
      updatedAt: null
    };
  }

  return {
    tenantId,
    source: 'tenant',
    policyStatus: 'active',
    mode: stored.mode,
    roster: stored.roster,
    deploymentDefaultMode,
    deploymentDefaultRoster,
    updatedAt: stored.updatedAt
  };
}

export async function evaluateSecurityExportOperatorAuthorization(options: {
  tenantId: string;
  action: SecurityExportOperatorAction;
  principalName: string | undefined;
}): Promise<SecurityExportOperatorAuthorizationDecision> {
  const policy = await getEffectiveSecurityExportOperatorPolicy(options.tenantId);
  const principalName = normalizePrincipalName(options.principalName ?? '');

  if (!principalName) {
    return {
      allowed: false,
      action: options.action,
      principalName,
      policy,
      reason: 'principal_missing'
    };
  }

  if (policy.mode === 'open_admins') {
    return {
      allowed: true,
      action: options.action,
      principalName,
      policy,
      reason: 'open_admins'
    };
  }

  const allowed = policy.roster[options.action].includes(principalName);
  return {
    allowed,
    action: options.action,
    principalName,
    policy,
    reason: allowed ? 'role_match' : 'principal_not_in_role'
  };
}
