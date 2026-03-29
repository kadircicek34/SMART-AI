export const AUTH_SCOPE_VALUES = ['tenant:read', 'tenant:operate', 'tenant:admin'] as const;

export type AuthScope = (typeof AUTH_SCOPE_VALUES)[number];

export type AuthPrincipal = {
  name: string;
  scopes: AuthScope[];
  source: 'legacy_csv' | 'definitions_json' | 'dev_fallback' | 'ui_session';
};

const AUTH_SCOPE_SET = new Set<AuthScope>(AUTH_SCOPE_VALUES);

const IMPLIED_SCOPES: Record<AuthScope, AuthScope[]> = {
  'tenant:read': [],
  'tenant:operate': ['tenant:read'],
  'tenant:admin': ['tenant:operate', 'tenant:read']
};

export function isAuthScope(value: string): value is AuthScope {
  return AUTH_SCOPE_SET.has(value as AuthScope);
}

export function normalizeAuthScopes(input: Iterable<string | AuthScope>): AuthScope[] {
  const deduped = new Set<AuthScope>();

  for (const raw of input) {
    const value = String(raw ?? '').trim();
    if (!isAuthScope(value)) {
      continue;
    }

    deduped.add(value);
    for (const implied of IMPLIED_SCOPES[value]) {
      deduped.add(implied);
    }
  }

  return AUTH_SCOPE_VALUES.filter((scope) => deduped.has(scope));
}

export function hasAuthScope(scopes: Iterable<string | AuthScope>, requiredScope: AuthScope): boolean {
  const normalized = normalizeAuthScopes(scopes);
  return normalized.includes(requiredScope);
}

export function describeAuthPermissions(scopes: Iterable<string | AuthScope>) {
  return {
    canRead: hasAuthScope(scopes, 'tenant:read'),
    canOperate: hasAuthScope(scopes, 'tenant:operate'),
    canAdmin: hasAuthScope(scopes, 'tenant:admin')
  };
}

function normalizePath(url: string): string {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return url.split('?')[0] || '/';
  }
}

export function resolveRequiredScope(method: string, url: string): AuthScope {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const pathname = normalizePath(url);

  if (
    pathname.startsWith('/v1/keys/openrouter') ||
    pathname.startsWith('/v1/ui/sessions') ||
    pathname === '/v1/security/export' ||
    pathname === '/v1/security/export/verify'
  ) {
    return 'tenant:admin';
  }

  if ((pathname === '/v1/model-policy' && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') ||
      (pathname === '/v1/rag/remote-policy' && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') ||
      pathname === '/v1/mcp/reset' ||
      pathname === '/v1/mcp/flush') {
    return 'tenant:admin';
  }

  if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD') {
    return 'tenant:read';
  }

  return 'tenant:operate';
}
