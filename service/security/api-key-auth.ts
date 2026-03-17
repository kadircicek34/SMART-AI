import crypto from 'node:crypto';
import { config } from '../config.js';

function secureEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function isAuthorizedApiKey(token: string): boolean {
  if (config.appApiKeys.length === 0) {
    return token.length > 0; // dev fallback: any non-empty bearer token
  }

  return config.appApiKeys.some((key) => secureEqual(key, token));
}
