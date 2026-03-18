function normalizeOrigin(origin: string): string | null {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return null;
  }
}

export function isOriginAllowed(originHeader: string | undefined, allowedOrigins: string[]): boolean {
  if (!originHeader) {
    return true;
  }

  const normalized = normalizeOrigin(originHeader);
  if (!normalized) {
    return false;
  }

  if (allowedOrigins.length === 0) {
    return true;
  }

  return allowedOrigins.includes(normalized);
}

export function normalizeAllowedOrigins(origins: string[]): string[] {
  const deduped = new Set<string>();

  for (const origin of origins) {
    const normalized = normalizeOrigin(origin);
    if (normalized) deduped.add(normalized);
  }

  return Array.from(deduped);
}
