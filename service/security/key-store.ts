import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

type EncryptedValue = {
  iv: string;
  tag: string;
  data: string;
};

type KeyStoreFile = {
  tenants: Record<string, EncryptedValue>;
};

const OPENROUTER_KEY_PREFIX = 'sk-or-v1-';

function encrypt(plain: string): EncryptedValue {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.security.masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64')
  };
}

function decrypt(payload: EncryptedValue): string {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    config.security.masterKey,
    Buffer.from(payload.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final()
  ]);
  return plain.toString('utf8');
}

async function ensureStoreExists() {
  await fs.mkdir(path.dirname(config.storage.keyStoreFile), { recursive: true });
  try {
    await fs.access(config.storage.keyStoreFile);
  } catch {
    const initial: KeyStoreFile = { tenants: {} };
    await fs.writeFile(config.storage.keyStoreFile, JSON.stringify(initial, null, 2), 'utf8');
  }
}

async function readStore(): Promise<KeyStoreFile> {
  await ensureStoreExists();
  const raw = await fs.readFile(config.storage.keyStoreFile, 'utf8');
  const parsed = JSON.parse(raw) as KeyStoreFile;
  return parsed?.tenants ? parsed : { tenants: {} };
}

async function writeStore(store: KeyStoreFile) {
  await ensureStoreExists();
  await fs.writeFile(config.storage.keyStoreFile, JSON.stringify(store, null, 2), 'utf8');
}

export function validateOpenRouterKeyShape(apiKey: string): boolean {
  return apiKey.startsWith(OPENROUTER_KEY_PREFIX) && apiKey.length >= OPENROUTER_KEY_PREFIX.length + 20;
}

export async function setTenantOpenRouterKey(tenantId: string, apiKey: string): Promise<void> {
  if (!validateOpenRouterKeyShape(apiKey)) {
    throw new Error('Invalid OpenRouter API key format.');
  }

  const store = await readStore();
  store.tenants[tenantId] = encrypt(apiKey.trim());
  await writeStore(store);
}

export async function getTenantOpenRouterKey(tenantId: string): Promise<string | null> {
  const store = await readStore();
  const payload = store.tenants[tenantId];
  if (!payload) return null;
  return decrypt(payload);
}

export async function deleteTenantOpenRouterKey(tenantId: string): Promise<boolean> {
  const store = await readStore();
  const exists = Boolean(store.tenants[tenantId]);
  if (exists) {
    delete store.tenants[tenantId];
    await writeStore(store);
  }
  return exists;
}

export async function hasTenantOpenRouterKey(tenantId: string): Promise<boolean> {
  const store = await readStore();
  return Boolean(store.tenants[tenantId]);
}
