import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { RagChunkRecord, RagDocumentRecord, RagStorePayload } from './types.js';

const EMPTY_STORE: RagStorePayload = {
  documents: {},
  chunks: {}
};

let queue: Promise<unknown> = Promise.resolve();

async function ensureParent(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readStore(filePath: string): Promise<RagStorePayload> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<RagStorePayload>;

    return {
      documents: parsed.documents ?? {},
      chunks: parsed.chunks ?? {}
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...EMPTY_STORE, documents: {}, chunks: {} };
    }
    throw error;
  }
}

async function writeStore(filePath: string, store: RagStorePayload) {
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

export async function withRagStore<T>(handler: (store: RagStorePayload) => Promise<T> | T): Promise<T> {
  return withLock(async () => {
    const filePath = config.rag.storeFile;
    const store = await readStore(filePath);
    const result = await handler(store);
    await writeStore(filePath, store);
    return result;
  });
}

export async function readOnlyRagStore<T>(handler: (store: RagStorePayload) => Promise<T> | T): Promise<T> {
  return withLock(async () => {
    const filePath = config.rag.storeFile;
    const store = await readStore(filePath);
    return handler(store);
  });
}

export function collectTenantChunks(store: RagStorePayload, tenantId: string): RagChunkRecord[] {
  return Object.values(store.chunks).filter((chunk) => chunk.tenantId === tenantId);
}

export function collectTenantDocuments(store: RagStorePayload, tenantId: string): RagDocumentRecord[] {
  return Object.values(store.documents).filter((doc) => doc.tenantId === tenantId);
}
