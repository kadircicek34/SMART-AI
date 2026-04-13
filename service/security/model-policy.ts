import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
const MODEL_POLICY_CHANGE_REASON_MIN_LENGTH = 8;
const MODEL_POLICY_CHANGE_REASON_MAX_LENGTH = 280;

export type ModelPolicyActor = {
  principalName?: string | null;
  authMode?: 'api_key' | 'ui_session' | 'unknown' | null;
};

type ModelPolicyFile = {
  tenants: Record<string, StoredTenantModelPolicy>;
};

export type StoredTenantModelPolicy = {
  state: 'active' | 'reset';
  allowedModels: string[];
  defaultModel: string | null;
  updatedAt: string;
  revision: number;
  updatedBy: string | null;
  updatedByAuthMode: 'api_key' | 'ui_session' | 'unknown' | null;
  changeReason: string | null;
};

export type EffectiveModelPolicy = {
  tenantId: string;
  source: 'deployment' | 'tenant';
  policyStatus: 'inherited' | 'active' | 'invalid';
  allowedModels: string[];
  defaultModel: string | null;
  deploymentAllowedModels: string[];
  updatedAt: string | null;
  revision: number;
  updatedBy: string | null;
  updatedByAuthMode: 'api_key' | 'ui_session' | 'unknown' | null;
  changeReason: string | null;
  lastChangeKind: 'deployment_default' | 'override' | 'reset';
  reasoningAllowedModels: string[];
};

export type TenantModelPolicyInput = {
  allowedModels: string[];
  defaultModel: string;
};

export type TenantModelPolicyPreview = {
  tenantId: string;
  currentRevision: number;
  nextRevision: number;
  currentSource: 'deployment' | 'tenant';
  currentPolicyStatus: 'inherited' | 'active' | 'invalid';
  wouldChange: boolean;
  changeKind:
    | 'no_change'
    | 'create_override'
    | 'tighten_override'
    | 'widen_override'
    | 'rotate_default'
    | 'equivalent_to_reset';
  currentDefaultModel: string | null;
  candidateDefaultModel: string;
  diff: {
    addedModels: string[];
    removedModels: string[];
    unchangedModels: string[];
    defaultModelChanged: boolean;
  };
  reasoning: {
    currentModels: string[];
    candidateModels: string[];
    removedModels: string[];
    remainingModels: string[];
    defaultModelReasoningEnabled: boolean;
  };
  risk: {
    level: 'low' | 'medium' | 'high';
    reasons: string[];
  };
  warnings: string[];
  candidatePolicy: {
    allowedModels: string[];
    defaultModel: string;
  };
};

export type ResolveTenantModelResult =
  | {
      ok: true;
      model: string;
      policy: EffectiveModelPolicy;
      usedDefault: boolean;
    }
  | {
      ok: false;
      policy: EffectiveModelPolicy;
      statusCode: number;
      errorType: 'invalid_request_error' | 'permission_error';
      message: string;
      auditReason: 'invalid_model_format' | 'model_not_allowed' | 'tenant_policy_invalid';
      normalizedModel?: string;
    };

function normalize(model: string): string {
  return model.trim();
}

function normalizeActorName(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').trim().slice(0, 128);
  return normalized || null;
}

function normalizeActorMode(value: string | null | undefined): 'api_key' | 'ui_session' | 'unknown' | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'api_key' || normalized === 'ui_session') {
    return normalized;
  }

  return normalized ? 'unknown' : null;
}

export function normalizeModelPolicyChangeReason(value: string | undefined): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MODEL_POLICY_CHANGE_REASON_MAX_LENGTH);
}

function validateModelPolicyChangeControl(params: {
  expectedRevision: number;
  changeReason: string;
}): { ok: true; value: { expectedRevision: number; changeReason: string } } | { ok: false; reason: string; code: string; statusCode: number } {
  const expectedRevision = Number(params.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    return {
      ok: false,
      reason: 'expectedRevision must be a non-negative integer.',
      code: 'invalid_expected_revision',
      statusCode: 400
    };
  }

  const changeReason = normalizeModelPolicyChangeReason(params.changeReason);
  if (changeReason.length < MODEL_POLICY_CHANGE_REASON_MIN_LENGTH) {
    return {
      ok: false,
      reason: `changeReason must be at least ${MODEL_POLICY_CHANGE_REASON_MIN_LENGTH} characters.`,
      code: 'change_reason_too_short',
      statusCode: 400
    };
  }

  return {
    ok: true,
    value: {
      expectedRevision,
      changeReason
    }
  };
}

function dedupeModels(models: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const item of models) {
    const value = normalize(item);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

function getDeploymentAllowedModels(): string[] {
  return dedupeModels(config.openRouter.allowedModels.filter(Boolean));
}

function getDeploymentDefaultModel(): string {
  const allowed = getDeploymentAllowedModels();
  const configured = normalize(config.openRouter.defaultModel);

  if (allowed.includes(configured)) {
    return configured;
  }

  if (allowed[0]) {
    return allowed[0];
  }

  return configured;
}

function getReasoningAllowedModels(models: string[]): string[] {
  const reasoningSet = new Set(config.openRouter.reasoningModels.map((model) => normalize(model).toLowerCase()));
  return models.filter((model) => reasoningSet.has(normalize(model).toLowerCase()));
}

function hasSameMembers(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const leftSet = new Set(left);
  return right.every((value) => leftSet.has(value));
}

function diffModels(current: string[], candidate: string[]) {
  const currentSet = new Set(current);
  const candidateSet = new Set(candidate);

  return {
    addedModels: candidate.filter((model) => !currentSet.has(model)),
    removedModels: current.filter((model) => !candidateSet.has(model)),
    unchangedModels: candidate.filter((model) => currentSet.has(model))
  };
}

async function ensureStoreExists(): Promise<void> {
  await fs.mkdir(path.dirname(config.storage.modelPolicyFile), { recursive: true });
  try {
    await fs.access(config.storage.modelPolicyFile);
  } catch {
    const initial: ModelPolicyFile = { tenants: {} };
    await fs.writeFile(config.storage.modelPolicyFile, JSON.stringify(initial, null, 2), 'utf8');
  }
}

async function readStore(): Promise<ModelPolicyFile> {
  await ensureStoreExists();
  const raw = await fs.readFile(config.storage.modelPolicyFile, 'utf8');
  const parsed = JSON.parse(raw) as Partial<ModelPolicyFile>;
  return parsed?.tenants ? { tenants: parsed.tenants } : { tenants: {} };
}

async function writeStore(store: ModelPolicyFile): Promise<void> {
  await ensureStoreExists();
  await fs.writeFile(config.storage.modelPolicyFile, JSON.stringify(store, null, 2), 'utf8');
}

export function validateModelId(model: string): { ok: true; normalized: string } | { ok: false; reason: string } {
  const normalized = normalize(model);
  if (!normalized) {
    return { ok: false, reason: 'Model is required.' };
  }

  if (normalized.length > config.openRouter.modelIdMaxLength) {
    return { ok: false, reason: 'Model name is too long.' };
  }

  if (!MODEL_ID_PATTERN.test(normalized)) {
    return { ok: false, reason: 'Model format is invalid.' };
  }

  return { ok: true, normalized };
}

function sanitizeStoredAllowedModels(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    const validation = validateModelId(String(entry ?? ''));
    if (!validation.ok || seen.has(validation.normalized)) {
      continue;
    }

    seen.add(validation.normalized);
    normalized.push(validation.normalized);
  }

  return normalized;
}

function sanitizeStoredDefaultModel(input: unknown): string | null {
  const validation = validateModelId(String(input ?? ''));
  return validation.ok ? validation.normalized : null;
}

function sanitizeStoredTenantModelPolicy(value: unknown): StoredTenantModelPolicy | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<StoredTenantModelPolicy> & {
    state?: unknown;
    allowedModels?: unknown;
    defaultModel?: unknown;
    revision?: unknown;
    updatedBy?: unknown;
    updatedByAuthMode?: unknown;
    changeReason?: unknown;
    updatedAt?: unknown;
  };

  const rawState = String(candidate.state ?? '').trim().toLowerCase();
  const state: StoredTenantModelPolicy['state'] = rawState === 'reset' ? 'reset' : 'active';
  const revision = Number(candidate.revision);
  const updatedAt = String(candidate.updatedAt ?? '').trim();
  const parsedUpdatedAt = Date.parse(updatedAt);

  return {
    state,
    allowedModels: state === 'reset' ? [] : sanitizeStoredAllowedModels(candidate.allowedModels),
    defaultModel: state === 'reset' ? null : sanitizeStoredDefaultModel(candidate.defaultModel),
    updatedAt: Number.isFinite(parsedUpdatedAt) ? new Date(parsedUpdatedAt).toISOString() : new Date().toISOString(),
    revision: Number.isInteger(revision) && revision > 0 ? revision : 1,
    updatedBy: normalizeActorName(typeof candidate.updatedBy === 'string' ? candidate.updatedBy : null),
    updatedByAuthMode: normalizeActorMode(typeof candidate.updatedByAuthMode === 'string' ? candidate.updatedByAuthMode : null),
    changeReason: normalizeModelPolicyChangeReason(typeof candidate.changeReason === 'string' ? candidate.changeReason : undefined) || null
  };
}

export function isAllowedModel(model: string): boolean {
  const normalized = normalize(model);
  return getDeploymentAllowedModels().includes(normalized);
}

export function listAllowedModels(): string[] {
  return getDeploymentAllowedModels();
}

export function validateTenantModelPolicyInput(input: TenantModelPolicyInput):
  | { ok: true; value: TenantModelPolicyInput }
  | { ok: false; reason: string; code: string; statusCode: number } {
  const deploymentAllowedModels = getDeploymentAllowedModels();
  const deploymentAllowedSet = new Set(deploymentAllowedModels);
  const allowedModels = dedupeModels(input.allowedModels ?? []);

  if (allowedModels.length === 0) {
    return {
      ok: false,
      reason: 'At least one allowed model must be configured for this tenant.',
      code: 'empty_allowed_models',
      statusCode: 400
    };
  }

  const maxAllowed = Math.max(1, Math.min(config.openRouter.maxTenantAllowedModels, deploymentAllowedModels.length));
  if (allowedModels.length > maxAllowed) {
    return {
      ok: false,
      reason: `Too many allowed models requested for this tenant (max ${maxAllowed}).`,
      code: 'too_many_allowed_models',
      statusCode: 400
    };
  }

  for (const model of allowedModels) {
    const validation = validateModelId(model);
    if (!validation.ok) {
      return {
        ok: false,
        reason: validation.reason,
        code: 'invalid_model_format',
        statusCode: 400
      };
    }

    if (!deploymentAllowedSet.has(validation.normalized)) {
      return {
        ok: false,
        reason: 'One or more requested models are not allowed for this deployment.',
        code: 'model_not_in_deployment_allowlist',
        statusCode: 403
      };
    }
  }

  const defaultValidation = validateModelId(input.defaultModel);
  if (!defaultValidation.ok) {
    return {
      ok: false,
      reason: defaultValidation.reason,
      code: 'invalid_default_model',
      statusCode: 400
    };
  }

  if (!allowedModels.includes(defaultValidation.normalized)) {
    return {
      ok: false,
      reason: 'defaultModel must also be present in allowedModels.',
      code: 'default_not_in_allowed_models',
      statusCode: 400
    };
  }

  return {
    ok: true,
    value: {
      allowedModels,
      defaultModel: defaultValidation.normalized
    }
  };
}

export async function getTenantModelPolicy(tenantId: string): Promise<StoredTenantModelPolicy | null> {
  const store = await readStore();
  return sanitizeStoredTenantModelPolicy(store.tenants[tenantId]);
}

function getCurrentStoredRevision(policy: StoredTenantModelPolicy | null): number {
  return Math.max(0, policy?.revision ?? 0);
}

function buildStoredPolicyMetadata(params: {
  actor?: ModelPolicyActor;
  changeReason: string;
}) {
  return {
    updatedBy: normalizeActorName(params.actor?.principalName),
    updatedByAuthMode: normalizeActorMode(params.actor?.authMode),
    changeReason: normalizeModelPolicyChangeReason(params.changeReason) || null
  } satisfies Pick<StoredTenantModelPolicy, 'updatedBy' | 'updatedByAuthMode' | 'changeReason'>;
}

export async function previewTenantModelPolicyChange(
  tenantId: string,
  input: TenantModelPolicyInput
): Promise<
  | { ok: true; preview: TenantModelPolicyPreview }
  | { ok: false; reason: string; code: string; statusCode: number }
> {
  const validated = validateTenantModelPolicyInput(input);
  if (!validated.ok) {
    return validated;
  }

  const currentPolicy = await getEffectiveModelPolicy(tenantId);
  const currentAllowed = currentPolicy.allowedModels;
  const candidateAllowed = validated.value.allowedModels;
  const diff = diffModels(currentAllowed, candidateAllowed);
  const defaultModelChanged = currentPolicy.defaultModel !== validated.value.defaultModel;
  const currentReasoningModels = currentPolicy.reasoningAllowedModels;
  const candidateReasoningModels = getReasoningAllowedModels(candidateAllowed);
  const removedReasoningModels = currentReasoningModels.filter((model) => !candidateReasoningModels.includes(model));
  const remainingReasoningModels = candidateReasoningModels.filter((model) => currentReasoningModels.includes(model));

  let changeKind: TenantModelPolicyPreview['changeKind'] = 'create_override';
  const wouldChange =
    !hasSameMembers(currentAllowed, candidateAllowed) ||
    normalize(currentPolicy.defaultModel ?? '') !== normalize(validated.value.defaultModel);

  if (!wouldChange) {
    changeKind = 'no_change';
  } else if (
    currentPolicy.source === 'tenant' &&
    hasSameMembers(candidateAllowed, currentPolicy.deploymentAllowedModels) &&
    validated.value.defaultModel === getDeploymentDefaultModel()
  ) {
    changeKind = 'equivalent_to_reset';
  } else if (diff.addedModels.length === 0 && diff.removedModels.length === 0 && defaultModelChanged) {
    changeKind = 'rotate_default';
  } else if (currentPolicy.source === 'deployment') {
    changeKind = 'create_override';
  } else if (diff.removedModels.length > diff.addedModels.length) {
    changeKind = 'tighten_override';
  } else if (diff.addedModels.length > diff.removedModels.length) {
    changeKind = 'widen_override';
  } else if (diff.removedModels.length > 0) {
    changeKind = 'tighten_override';
  } else {
    changeKind = 'widen_override';
  }

  const warnings: string[] = [];
  const riskReasons: string[] = [];
  let riskLevel: TenantModelPolicyPreview['risk']['level'] = 'low';

  if (diff.removedModels.includes(currentPolicy.defaultModel ?? '')) {
    riskLevel = 'high';
    riskReasons.push('Current default model will be removed from the tenant allowlist.');
  }

  if (currentReasoningModels.length > 0 && candidateReasoningModels.length === 0) {
    riskLevel = 'high';
    riskReasons.push('All reasoning-capable models would be removed for this tenant.');
  }

  if (currentAllowed.length > 1 && candidateAllowed.length === 1) {
    if (riskLevel !== 'high') {
      riskLevel = 'medium';
    }
    riskReasons.push('Model redundancy will drop to a single allowed model.');
    warnings.push('Single-model policy fallback surface becomes narrower during provider incidents.');
  }

  if (defaultModelChanged) {
    if (riskLevel === 'low') {
      riskLevel = 'medium';
    }
    riskReasons.push('Tenant default model will change.');
  }

  if (removedReasoningModels.length > 0 && candidateReasoningModels.length > 0) {
    if (riskLevel === 'low') {
      riskLevel = 'medium';
    }
    riskReasons.push('Some reasoning-capable models would be removed.');
  }

  if (!candidateReasoningModels.includes(validated.value.defaultModel)) {
    warnings.push('Selected default model is not in the configured reasoning-capable model set.');
  }

  if (changeKind === 'equivalent_to_reset') {
    warnings.push('Candidate policy matches deployment defaults. Reset may be simpler than storing an explicit override.');
  }

  return {
    ok: true,
    preview: {
      tenantId,
      currentRevision: currentPolicy.revision,
      nextRevision: currentPolicy.revision + 1,
      currentSource: currentPolicy.source,
      currentPolicyStatus: currentPolicy.policyStatus,
      wouldChange,
      changeKind,
      currentDefaultModel: currentPolicy.defaultModel,
      candidateDefaultModel: validated.value.defaultModel,
      diff: {
        ...diff,
        defaultModelChanged
      },
      reasoning: {
        currentModels: currentReasoningModels,
        candidateModels: candidateReasoningModels,
        removedModels: removedReasoningModels,
        remainingModels: remainingReasoningModels,
        defaultModelReasoningEnabled: candidateReasoningModels.includes(validated.value.defaultModel)
      },
      risk: {
        level: riskLevel,
        reasons: riskReasons
      },
      warnings,
      candidatePolicy: {
        allowedModels: validated.value.allowedModels,
        defaultModel: validated.value.defaultModel
      }
    }
  };
}

export async function setTenantModelPolicy(
  tenantId: string,
  input: TenantModelPolicyInput,
  options: {
    expectedRevision: number;
    changeReason: string;
    actor?: ModelPolicyActor;
  }
): Promise<
  | { ok: true; policy: StoredTenantModelPolicy }
  | { ok: false; reason: string; code: string; statusCode: number; currentRevision?: number }
> {
  const validated = validateTenantModelPolicyInput(input);
  if (!validated.ok) {
    return validated;
  }

  const changeControl = validateModelPolicyChangeControl(options);
  if (!changeControl.ok) {
    return changeControl;
  }

  const store = await readStore();
  const current = sanitizeStoredTenantModelPolicy(store.tenants[tenantId]);
  const currentRevision = getCurrentStoredRevision(current);

  if (changeControl.value.expectedRevision !== currentRevision) {
    return {
      ok: false,
      reason: 'Model policy revision mismatch. Refresh current policy and retry.',
      code: 'revision_conflict',
      statusCode: 409,
      currentRevision
    };
  }

  const policy: StoredTenantModelPolicy = {
    state: 'active',
    allowedModels: validated.value.allowedModels,
    defaultModel: validated.value.defaultModel,
    updatedAt: new Date().toISOString(),
    revision: currentRevision + 1,
    ...buildStoredPolicyMetadata({
      actor: options.actor,
      changeReason: changeControl.value.changeReason
    })
  };

  store.tenants[tenantId] = policy;
  await writeStore(store);

  return { ok: true, policy };
}

export async function resetTenantModelPolicy(
  tenantId: string,
  options: {
    expectedRevision: number;
    changeReason: string;
    actor?: ModelPolicyActor;
  }
): Promise<
  | { ok: true; reset: boolean; policy: StoredTenantModelPolicy | null }
  | { ok: false; reason: string; code: string; statusCode: number; currentRevision?: number }
> {
  const changeControl = validateModelPolicyChangeControl(options);
  if (!changeControl.ok) {
    return changeControl;
  }

  const store = await readStore();
  const current = sanitizeStoredTenantModelPolicy(store.tenants[tenantId]);
  const currentRevision = getCurrentStoredRevision(current);

  if (changeControl.value.expectedRevision !== currentRevision) {
    return {
      ok: false,
      reason: 'Model policy revision mismatch. Refresh current policy and retry.',
      code: 'revision_conflict',
      statusCode: 409,
      currentRevision
    };
  }

  if (!current || current.state === 'reset') {
    return {
      ok: true,
      reset: false,
      policy: current
    };
  }

  const policy: StoredTenantModelPolicy = {
    state: 'reset',
    allowedModels: [],
    defaultModel: null,
    updatedAt: new Date().toISOString(),
    revision: currentRevision + 1,
    ...buildStoredPolicyMetadata({
      actor: options.actor,
      changeReason: changeControl.value.changeReason
    })
  };

  store.tenants[tenantId] = policy;
  await writeStore(store);

  return {
    ok: true,
    reset: true,
    policy
  };
}

export async function getEffectiveModelPolicy(tenantId: string): Promise<EffectiveModelPolicy> {
  const deploymentAllowedModels = getDeploymentAllowedModels();
  const stored = await getTenantModelPolicy(tenantId);
  const deploymentDefaultModel = getDeploymentDefaultModel();

  if (!stored) {
    return {
      tenantId,
      source: 'deployment',
      policyStatus: 'inherited',
      allowedModels: deploymentAllowedModels,
      defaultModel: deploymentDefaultModel,
      deploymentAllowedModels,
      updatedAt: null,
      revision: 0,
      updatedBy: null,
      updatedByAuthMode: null,
      changeReason: null,
      lastChangeKind: 'deployment_default',
      reasoningAllowedModels: getReasoningAllowedModels(deploymentAllowedModels)
    };
  }

  if (stored.state === 'reset') {
    return {
      tenantId,
      source: 'deployment',
      policyStatus: 'inherited',
      allowedModels: deploymentAllowedModels,
      defaultModel: deploymentDefaultModel,
      deploymentAllowedModels,
      updatedAt: stored.updatedAt,
      revision: stored.revision,
      updatedBy: stored.updatedBy,
      updatedByAuthMode: stored.updatedByAuthMode,
      changeReason: stored.changeReason,
      lastChangeKind: 'reset',
      reasoningAllowedModels: getReasoningAllowedModels(deploymentAllowedModels)
    };
  }

  const deploymentAllowedSet = new Set(deploymentAllowedModels);
  const allowedModels = dedupeModels(stored.allowedModels).filter((model) => deploymentAllowedSet.has(model));
  const defaultModel = stored.defaultModel && allowedModels.includes(stored.defaultModel) ? stored.defaultModel : (allowedModels[0] ?? null);

  return {
    tenantId,
    source: 'tenant',
    policyStatus: allowedModels.length > 0 && defaultModel ? 'active' : 'invalid',
    allowedModels,
    defaultModel,
    deploymentAllowedModels,
    updatedAt: stored.updatedAt,
    revision: stored.revision,
    updatedBy: stored.updatedBy,
    updatedByAuthMode: stored.updatedByAuthMode,
    changeReason: stored.changeReason,
    lastChangeKind: 'override',
    reasoningAllowedModels: getReasoningAllowedModels(allowedModels)
  };
}

export async function resolveTenantModel(tenantId: string, requestedModel?: string | null): Promise<ResolveTenantModelResult> {
  const policy = await getEffectiveModelPolicy(tenantId);

  if (policy.allowedModels.length === 0 || !policy.defaultModel) {
    return {
      ok: false,
      policy,
      statusCode: 403,
      errorType: 'permission_error',
      message: 'No allowed models are configured for this tenant.',
      auditReason: 'tenant_policy_invalid'
    };
  }

  if (!requestedModel || !requestedModel.trim()) {
    return {
      ok: true,
      model: policy.defaultModel,
      policy,
      usedDefault: true
    };
  }

  const validation = validateModelId(requestedModel);
  if (!validation.ok) {
    return {
      ok: false,
      policy,
      statusCode: 400,
      errorType: 'invalid_request_error',
      message: validation.reason,
      auditReason: 'invalid_model_format'
    };
  }

  if (!policy.allowedModels.includes(validation.normalized)) {
    return {
      ok: false,
      policy,
      statusCode: 403,
      errorType: 'permission_error',
      message:
        policy.source === 'tenant'
          ? 'Requested model is not allowed for this tenant.'
          : 'Requested model is not allowed for this deployment.',
      auditReason: 'model_not_allowed',
      normalizedModel: validation.normalized
    };
  }

  return {
    ok: true,
    model: validation.normalized,
    policy,
    usedDefault: false
  };
}
