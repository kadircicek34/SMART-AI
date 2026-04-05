import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function readJsonFileSync<T>(filePath: string | undefined): T | null {
  if (!filePath) {
    return null;
  }

  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJsonFileAtomicSync(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

export async function writeJsonFileAtomic(filePath: string, payload: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });

  const tmpPath = `${filePath}.tmp`;
  await fsp.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
  await fsp.rename(tmpPath, filePath);
}
