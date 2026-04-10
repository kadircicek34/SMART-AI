import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { readJsonFileSync, writeJsonFileAtomic } from '../persistence/json-file.js';
import {
  SECURITY_EXPORT_OPERATOR_POLICY_ACTIONS,
  type SecurityExportOperatorAction
} from './export-operator-policy.js';

export const SECURITY_EXPORT_OPERATOR_DELEGATION_STATUSES = ['active', 'consumed', 'revoked', 'expired'] as const;

export type SecurityExportOperatorDelegationStatus = (typeof SECURITY_EXPORT_OPERATOR_DELEGATION_STATUSES)[number];

export type SecurityExportOperatorDelegation = {
  grant_id: string;
  tenant_id: string;
  incident_id: string;
  action: SecurityExportOperatorAction;
  delegate_principal: string;
  issued_by: string;
  issued_at: string;
  expires_at: string;
  justification: string;
  status: SecurityExportOperatorDelegationStatus;
  consumed_at: string | null;
  consumed_by: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
};

type SecurityExportOperatorDelegationFile = {
  tenants: Record<string, SecurityExportOperatorDelegation[]>;
};

type CreateSecurityExportOperatorDelegationInput = {
  tenantId: string;
  incidentId: string;
  action: SecurityExportOperatorAction;
  delegatePrincipal: string;
  actor: string;
  justification: string;
  ttlMinutes?: number;
};

type MutateSecurityExportOperatorDelegationInput = {
  tenantId: string;
  grantId: string;
  incidentId: string;
  action: SecurityExportOperatorAction;
  actor: string;
};

type RevokeSecurityExportOperatorDelegationInput = {
  tenantId: string;
  grantId: string;
  actor: string;
  reason: string;
};

type SecurityExportOperatorDelegationErrorResult = {
  ok: false;
  reason: string;
  code: string;
  statusCode: number;
};

const PRINCIPAL_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const INCIDENT_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sanitizeString(value: string | undefined, maxLength: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function isAction(value: string): value is SecurityExportOperatorAction {
  return SECURITY_EXPORT_OPERATOR_POLICY_ACTIONS.includes(value as SecurityExportOperatorAction);
}

function isStatus(value: string): value is SecurityExportOperatorDelegationStatus {
  return SECURITY_EXPORT_OPERATOR_DELEGATION_STATUSES.includes(value as SecurityExportOperatorDelegationStatus);
}

function normalizePrincipal(value: string | undefined): string {
  return sanitizeString(value, 128);
}

function normalizeIncidentId(value: string | undefined): string {
  return sanitizeString(value, 64).toLowerCase();
}

function normalizeAction(value: string | undefined): SecurityExportOperatorAction | null {
  const normalized = sanitizeString(value, 32).toLowerCase();
  return isAction(normalized) ? normalized : null;
}

function normalizeJustification(value: string | undefined): string {
  return sanitizeString(value, 280);
}

function getDefaultTtlMinutes(): number {
  return Math.max(1, Math.trunc(config.security.exportOperatorDelegationDefaultTtlMinutes));
}

function getMaxTtlMinutes(): number {
  return Math.max(getDefaultTtlMinutes(), Math.trunc(config.security.exportOperatorDelegationMaxTtlMinutes));
}

function resolveTtlMinutes(value: number | undefined): number {
  const fallback = getDefaultTtlMinutes();
  const configuredMax = getMaxTtlMinutes();
  const candidate = value === undefined ? fallback : Math.trunc(Number(value));

  if (!Number.isFinite(candidate) || candidate <= 0) {
    return fallback;
  }

  return Math.min(configuredMax, Math.max(1, candidate));
}

function getMaxActivePerTenant(): number {
  return Math.max(1, Math.trunc(config.security.exportOperatorDelegationMaxActivePerTenant));
}

function materializeGrantStatus(
  grant: SecurityExportOperatorDelegation,
  now = Date.now()
): SecurityExportOperatorDelegation {
  if (grant.status !== 'active') {
    return grant;
  }

  const expiresAtMs = Date.parse(grant.expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs > now) {
    return grant;
  }

  return {
    ...grant,
    status: 'expired'
  };
}

function sortGrants(grants: SecurityExportOperatorDelegation[]): SecurityExportOperatorDelegation[] {
  return [...grants].sort((left, right) => Date.parse(right.issued_at) - Date.parse(left.issued_at));
}

function sanitizeStoredGrant(value: unknown): SecurityExportOperatorDelegation | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<SecurityExportOperatorDelegation>;
  const incidentId = normalizeIncidentId(candidate.incident_id);
  const action = normalizeAction(candidate.action);
  const delegatePrincipal = normalizePrincipal(candidate.delegate_principal);
  const issuedBy = normalizePrincipal(candidate.issued_by);
  const issuedAt = sanitizeString(candidate.issued_at, 64);
  const expiresAt = sanitizeString(candidate.expires_at, 64);
  const status = sanitizeString(candidate.status, 32).toLowerCase();

  if (
    !candidate.grant_id ||
    !candidate.tenant_id ||
    !INCIDENT_ID_REGEX.test(incidentId) ||
    !action ||
    !PRINCIPAL_NAME_REGEX.test(delegatePrincipal) ||
    !PRINCIPAL_NAME_REGEX.test(issuedBy) ||
    !Number.isFinite(Date.parse(issuedAt)) ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    !isStatus(status)
  ) {
    return null;
  }

  return materializeGrantStatus({
    grant_id: sanitizeString(candidate.grant_id, 96),
    tenant_id: sanitizeString(candidate.tenant_id, 128),
    incident_id: incidentId,
    action,
    delegate_principal: delegatePrincipal,
    issued_by: issuedBy,
    issued_at: new Date(Date.parse(issuedAt)).toISOString(),
    expires_at: new Date(Date.parse(expiresAt)).toISOString(),
    justification: normalizeJustification(candidate.justification),
    status,
    consumed_at: candidate.consumed_at && Number.isFinite(Date.parse(String(candidate.consumed_at)))
      ? new Date(Date.parse(String(candidate.consumed_at))).toISOString()
      : null,
    consumed_by: candidate.consumed_by ? normalizePrincipal(candidate.consumed_by) : null,
    revoked_at: candidate.revoked_at && Number.isFinite(Date.parse(String(candidate.revoked_at)))
      ? new Date(Date.parse(String(candidate.revoked_at))).toISOString()
      : null,
    revoked_by: candidate.revoked_by ? normalizePrincipal(candidate.revoked_by) : null,
    revoke_reason: candidate.revoke_reason ? normalizeJustification(candidate.revoke_reason) : null
  });
}

function readStore(): SecurityExportOperatorDelegationFile {
  const parsed = readJsonFileSync<SecurityExportOperatorDelegationFile>(config.storage.securityExportOperatorDelegationFile);
  const tenants: Record<string, SecurityExportOperatorDelegation[]> = {};

  if (!parsed?.tenants || typeof parsed.tenants !== 'object') {
    return { tenants };
  }

  for (const [tenantId, values] of Object.entries(parsed.tenants)) {
    if (!Array.isArray(values)) {
      continue;
    }

    tenants[tenantId] = values.map((entry) => sanitizeStoredGrant(entry)).filter((entry): entry is SecurityExportOperatorDelegation => Boolean(entry));
  }

  return { tenants };
}

async function writeStore(store: SecurityExportOperatorDelegationFile): Promise<void> {
  await writeJsonFileAtomic(config.storage.securityExportOperatorDelegationFile, {
    tenants: Object.fromEntries(
      Object.entries(store.tenants).map(([tenantId, grants]) => [tenantId, sortGrants(grants)])
    )
  });
}

function withMaterializedTenantGrants(
  store: SecurityExportOperatorDelegationFile,
  tenantId: string,
  now = Date.now()
): SecurityExportOperatorDelegation[] {
  const grants = (store.tenants[tenantId] ?? []).map((grant) => materializeGrantStatus(grant, now));
  store.tenants[tenantId] = sortGrants(grants);
  return store.tenants[tenantId];
}

function errorResult(reason: string, code: string, statusCode: number): SecurityExportOperatorDelegationErrorResult {
  return {
    ok: false,
    reason,
    code,
    statusCode
  };
}

export async function listSecurityExportOperatorDelegations(
  tenantId: string,
  options: {
    limit?: number;
    status?: SecurityExportOperatorDelegationStatus;
  } = {}
): Promise<SecurityExportOperatorDelegation[]> {
  const store = readStore();
  const grants = withMaterializedTenantGrants(store, tenantId);
  const limit = Math.max(1, Math.trunc(options.limit ?? 20));

  return grants
    .filter((grant) => (options.status ? grant.status === options.status : true))
    .slice(0, limit);
}

export async function findActiveSecurityExportOperatorDelegation(options: {
  tenantId: string;
  incidentId: string;
  action: SecurityExportOperatorAction;
  delegatePrincipal: string;
}): Promise<SecurityExportOperatorDelegation | null> {
  const store = readStore();
  const grants = withMaterializedTenantGrants(store, options.tenantId);
  const incidentId = normalizeIncidentId(options.incidentId);
  const delegatePrincipal = normalizePrincipal(options.delegatePrincipal);

  return (
    grants.find(
      (grant) =>
        grant.status === 'active' &&
        grant.incident_id === incidentId &&
        grant.action === options.action &&
        grant.delegate_principal === delegatePrincipal
    ) ?? null
  );
}

export async function createSecurityExportOperatorDelegation(
  input: CreateSecurityExportOperatorDelegationInput
): Promise<
  | { ok: true; grant: SecurityExportOperatorDelegation }
  | SecurityExportOperatorDelegationErrorResult
> {
  const incidentId = normalizeIncidentId(input.incidentId);
  if (!INCIDENT_ID_REGEX.test(incidentId)) {
    return errorResult('Invalid incident id for operator delegation.', 'incident_id_invalid', 400);
  }

  if (!isAction(input.action)) {
    return errorResult('Invalid operator delegation action.', 'action_invalid', 400);
  }

  const actor = normalizePrincipal(input.actor);
  if (!actor || !PRINCIPAL_NAME_REGEX.test(actor)) {
    return errorResult('Delegation issuer principal is invalid.', 'issuer_invalid', 400);
  }

  const delegatePrincipal = normalizePrincipal(input.delegatePrincipal);
  if (!delegatePrincipal || !PRINCIPAL_NAME_REGEX.test(delegatePrincipal)) {
    return errorResult('Delegation target principal is invalid.', 'delegate_principal_invalid', 400);
  }

  if (actor === delegatePrincipal) {
    return errorResult('Delegation issuer cannot grant break-glass access to the same principal.', 'delegate_principal_conflict', 400);
  }

  const justification = normalizeJustification(input.justification);
  if (justification.length < 8) {
    return errorResult('Delegation justification must be at least 8 characters.', 'justification_too_short', 400);
  }

  const maxTtlMinutes = getMaxTtlMinutes();
  const ttlCandidate = Number(input.ttlMinutes ?? resolveTtlMinutes(undefined));
  if (!Number.isFinite(ttlCandidate) || Math.trunc(ttlCandidate) <= 0) {
    return errorResult('Delegation TTL must be a positive integer.', 'ttl_invalid', 400);
  }

  if (Math.trunc(ttlCandidate) > maxTtlMinutes) {
    return errorResult(`Delegation TTL exceeds the configured maximum (${maxTtlMinutes} minutes).`, 'ttl_too_large', 400);
  }

  const ttlMinutes = resolveTtlMinutes(ttlCandidate);
  const store = readStore();
  const grants = withMaterializedTenantGrants(store, input.tenantId);
  const activeGrants = grants.filter((grant) => grant.status === 'active');

  if (activeGrants.length >= getMaxActivePerTenant()) {
    return errorResult('Too many active operator delegations for this tenant.', 'delegation_limit_exceeded', 429);
  }

  const duplicate = activeGrants.find(
    (grant) =>
      grant.incident_id === incidentId &&
      grant.action === input.action &&
      grant.delegate_principal === delegatePrincipal
  );
  if (duplicate) {
    return errorResult('A matching operator delegation is already active for this incident/action/principal.', 'delegation_already_active', 409);
  }

  const issuedAt = new Date().toISOString();
  const grant: SecurityExportOperatorDelegation = {
    grant_id: crypto.randomUUID(),
    tenant_id: sanitizeString(input.tenantId, 128),
    incident_id: incidentId,
    action: input.action,
    delegate_principal: delegatePrincipal,
    issued_by: actor,
    issued_at: issuedAt,
    expires_at: new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString(),
    justification,
    status: 'active',
    consumed_at: null,
    consumed_by: null,
    revoked_at: null,
    revoked_by: null,
    revoke_reason: null
  };

  grants.unshift(grant);
  store.tenants[input.tenantId] = sortGrants(grants);
  await writeStore(store);

  return {
    ok: true,
    grant
  };
}

export async function consumeSecurityExportOperatorDelegation(
  input: MutateSecurityExportOperatorDelegationInput
): Promise<
  | { ok: true; grant: SecurityExportOperatorDelegation }
  | SecurityExportOperatorDelegationErrorResult
> {
  const store = readStore();
  const grants = withMaterializedTenantGrants(store, input.tenantId);
  const actor = normalizePrincipal(input.actor);
  const incidentId = normalizeIncidentId(input.incidentId);
  const index = grants.findIndex((grant) => grant.grant_id === sanitizeString(input.grantId, 96));

  if (index < 0) {
    return errorResult('Operator delegation not found.', 'delegation_not_found', 404);
  }

  const current = grants[index];
  if (!current || current.status !== 'active') {
    return errorResult('Operator delegation is no longer active.', 'delegation_inactive', 409);
  }

  if (current.incident_id !== incidentId || current.action !== input.action || current.delegate_principal !== actor) {
    return errorResult('Operator delegation does not match this incident/action/principal.', 'delegation_mismatch', 409);
  }

  const updated: SecurityExportOperatorDelegation = {
    ...current,
    status: 'consumed',
    consumed_at: new Date().toISOString(),
    consumed_by: actor
  };

  grants[index] = updated;
  store.tenants[input.tenantId] = sortGrants(grants);
  await writeStore(store);

  return {
    ok: true,
    grant: updated
  };
}

export async function revokeSecurityExportOperatorDelegation(
  input: RevokeSecurityExportOperatorDelegationInput
): Promise<
  | { ok: true; grant: SecurityExportOperatorDelegation }
  | SecurityExportOperatorDelegationErrorResult
> {
  const reason = normalizeJustification(input.reason);
  if (reason.length < 8) {
    return errorResult('Delegation revoke reason must be at least 8 characters.', 'revoke_reason_too_short', 400);
  }

  const store = readStore();
  const grants = withMaterializedTenantGrants(store, input.tenantId);
  const actor = normalizePrincipal(input.actor);
  const index = grants.findIndex((grant) => grant.grant_id === sanitizeString(input.grantId, 96));

  if (index < 0) {
    return errorResult('Operator delegation not found.', 'delegation_not_found', 404);
  }

  const current = grants[index];
  if (!current || current.status !== 'active') {
    return errorResult('Only active operator delegations can be revoked.', 'delegation_inactive', 409);
  }

  const updated: SecurityExportOperatorDelegation = {
    ...current,
    status: 'revoked',
    revoked_at: new Date().toISOString(),
    revoked_by: actor,
    revoke_reason: reason
  };

  grants[index] = updated;
  store.tenants[input.tenantId] = sortGrants(grants);
  await writeStore(store);

  return {
    ok: true,
    grant: updated
  };
}

export const __private__ = {
  resetStoreForTests() {
    fs.mkdirSync(path.dirname(config.storage.securityExportOperatorDelegationFile), { recursive: true });
    fs.writeFileSync(
      config.storage.securityExportOperatorDelegationFile,
      JSON.stringify({ tenants: {} }, null, 2),
      'utf8'
    );
  }
};
