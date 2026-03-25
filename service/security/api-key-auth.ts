import crypto from 'node:crypto';
import { config } from '../config.js';
import { normalizeAuthScopes, type AuthPrincipal } from './authz.js';

export type ResolvedApiKey = AuthPrincipal & {
  token: string;
};

function secureEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function buildConfiguredApiKeys(): ResolvedApiKey[] {
  const structured = config.appApiKeyDefinitions.map((definition) => ({
    token: definition.key,
    name: definition.name,
    scopes: normalizeAuthScopes(definition.scopes),
    source: 'definitions_json' as const
  }));

  const legacy = config.appApiKeys.map((key, index) => ({
    token: key,
    name: `legacy-key-${index + 1}`,
    scopes: normalizeAuthScopes(['tenant:admin']),
    source: 'legacy_csv' as const
  }));

  return [...structured, ...legacy];
}

export function resolveApiKey(token: string): ResolvedApiKey | null {
  const candidate = String(token ?? '').trim();
  if (!candidate) {
    return null;
  }

  const configured = buildConfiguredApiKeys();
  const hit = configured.find((entry) => secureEqual(entry.token, candidate));
  if (hit) {
    return hit;
  }

  if (configured.length === 0 && candidate.length > 0) {
    return {
      token: candidate,
      name: 'dev-fallback',
      scopes: normalizeAuthScopes(['tenant:admin']),
      source: 'dev_fallback'
    };
  }

  return null;
}

export function isAuthorizedApiKey(token: string): boolean {
  return resolveApiKey(token) !== null;
}
