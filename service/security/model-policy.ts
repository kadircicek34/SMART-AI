import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;

type ModelPolicyFile = {
  tenants: Record<string, StoredTenantModelPolicy>;
};

export type StoredTenantModelPolicy = {
  allowedModels: string[];
  defaultModel: string;
  updatedAt: string;
};

export type EffectiveModelPolicy = {
  tenantId: string;
  source: 'deployment' | 'tenant';
  policyStatus: 'inherited' | 'active' | 'invalid';
  allowedModels: string[];
  defaultModel: string | null;
  deploymentAllowedModels: string[];
  updatedAt: string | null;
};

export type TenantModelPolicyInput = {
  allowedModels: string[];
  defaultModel: string;
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
  return store.tenants[tenantId] ?? null;
}

export async function setTenantModelPolicy(
  tenantId: string,
  input: TenantModelPolicyInput
): Promise<
  | { ok: true; policy: StoredTenantModelPolicy }
  | { ok: false; reason: string; code: string; statusCode: number }
> {
  const validated = validateTenantModelPolicyInput(input);
  if (!validated.ok) {
    return validated;
  }

  const store = await readStore();
  const policy: StoredTenantModelPolicy = {
    allowedModels: validated.value.allowedModels,
    defaultModel: validated.value.defaultModel,
    updatedAt: new Date().toISOString()
  };

  store.tenants[tenantId] = policy;
  await writeStore(store);

  return { ok: true, policy };
}

export async function resetTenantModelPolicy(tenantId: string): Promise<boolean> {
  const store = await readStore();
  const existed = Boolean(store.tenants[tenantId]);

  if (existed) {
    delete store.tenants[tenantId];
    await writeStore(store);
  }

  return existed;
}

export async function getEffectiveModelPolicy(tenantId: string): Promise<EffectiveModelPolicy> {
  const deploymentAllowedModels = getDeploymentAllowedModels();
  const stored = await getTenantModelPolicy(tenantId);

  if (!stored) {
    return {
      tenantId,
      source: 'deployment',
      policyStatus: 'inherited',
      allowedModels: deploymentAllowedModels,
      defaultModel: getDeploymentDefaultModel(),
      deploymentAllowedModels,
      updatedAt: null
    };
  }

  const deploymentAllowedSet = new Set(deploymentAllowedModels);
  const allowedModels = dedupeModels(stored.allowedModels).filter((model) => deploymentAllowedSet.has(model));
  const defaultModel = allowedModels.includes(stored.defaultModel) ? stored.defaultModel : (allowedModels[0] ?? null);

  return {
    tenantId,
    source: 'tenant',
    policyStatus: allowedModels.length > 0 && defaultModel ? 'active' : 'invalid',
    allowedModels,
    defaultModel,
    deploymentAllowedModels,
    updatedAt: stored.updatedAt
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
