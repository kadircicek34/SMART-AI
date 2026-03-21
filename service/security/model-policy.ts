import { config } from '../config.js';

const MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;

function normalize(model: string): string {
  return model.trim();
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
  return config.openRouter.allowedModels.includes(normalized);
}

export function listAllowedModels(): string[] {
  return [...new Set(config.openRouter.allowedModels.filter(Boolean))];
}
