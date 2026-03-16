import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { MemoryItemRecord, MemoryStorePayload } from './types.js';

const EMPTY_STORE: MemoryStorePayload = {
  items: {},
  tenantMetrics: {}
};

let queue: Promise<unknown> = Promise.resolve();

async function ensureParent(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readStore(filePath: string): Promise<MemoryStorePayload> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<MemoryStorePayload>;

    return {
      items: parsed.items ?? {},
      tenantMetrics: parsed.tenantMetrics ?? {}
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...EMPTY_STORE, items: {} };
    }
    throw error;
  }
}

async function writeStore(filePath: string, store: MemoryStorePayload) {
  await ensureParent(filePath);
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
}

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

export async function withMemoryStore<T>(handler: (store: MemoryStorePayload) => Promise<T> | T): Promise<T> {
  return withLock(async () => {
    const filePath = config.memory.storeFile;
    const store = await readStore(filePath);
    const result = await handler(store);
    await writeStore(filePath, store);
    return result;
  });
}

export async function readOnlyMemoryStore<T>(handler: (store: MemoryStorePayload) => Promise<T> | T): Promise<T> {
  return withLock(async () => {
    const filePath = config.memory.storeFile;
    const store = await readStore(filePath);
    return handler(store);
  });
}

export function collectTenantMemories(store: MemoryStorePayload, tenantId: string): MemoryItemRecord[] {
  return Object.values(store.items).filter((item) => item.tenantId === tenantId);
}
