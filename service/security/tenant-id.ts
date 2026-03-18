const TENANT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/;

export function isValidTenantId(value: string): boolean {
  return TENANT_ID_PATTERN.test(value);
}

export function normalizeTenantId(value: unknown): string {
  return String(value ?? '').trim();
}
