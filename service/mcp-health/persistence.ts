import { readMcpHealthSnapshotSync, writeMcpHealthSnapshot } from './store.js';
import type { McpHealthMetrics } from './types.js';

type SnapshotPersistence = {
  read(): Promise<McpHealthMetrics | null>;
  write(metrics: McpHealthMetrics): Promise<void>;
};

type HttpPersistenceConfig = {
  url: string;
  token?: string;
  timeoutMs: number;
};

export function createFileSnapshotPersistence(filePath: string): SnapshotPersistence {
  return {
    async read() {
      return readMcpHealthSnapshotSync(filePath);
    },
    async write(metrics) {
      await writeMcpHealthSnapshot(filePath, metrics);
    }
  };
}

export function createHttpSnapshotPersistence(config: HttpPersistenceConfig): SnapshotPersistence {
  const baseHeaders: Record<string, string> = { 'content-type': 'application/json' };
  if (config.token) {
    baseHeaders.authorization = `Bearer ${config.token}`;
  }

  return {
    async read() {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(500, config.timeoutMs));

      try {
        const res = await fetch(config.url, {
          method: 'GET',
          headers: baseHeaders,
          signal: controller.signal
        });

        if (res.status === 404) return null;
        if (!res.ok) return null;

        return (await res.json()) as McpHealthMetrics;
      } catch {
        return null;
      } finally {
        clearTimeout(timeout);
      }
    },
    async write(metrics) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(500, config.timeoutMs));

      try {
        await fetch(config.url, {
          method: 'PUT',
          headers: baseHeaders,
          body: JSON.stringify(metrics),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}

export function createMcpHealthPersistence(options: {
  enabled: boolean;
  mode: 'file' | 'http';
  filePath: string;
  httpUrl?: string;
  httpToken?: string;
  httpTimeoutMs: number;
}): SnapshotPersistence | null {
  if (!options.enabled) return null;

  if (options.mode === 'http' && options.httpUrl) {
    return createHttpSnapshotPersistence({
      url: options.httpUrl,
      token: options.httpToken,
      timeoutMs: options.httpTimeoutMs
    });
  }

  return createFileSnapshotPersistence(options.filePath);
}
