import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { McpHealthMetrics, McpHealthStatus, McpServerId } from './types.js';
import { MCP_SERVER_IDS } from './types.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

function toNumber(value: unknown, fallback = 0): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number.isFinite(value) ? Number(value) : null;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function sanitizeServerHealth(serverId: McpServerId, value: unknown): McpHealthStatus {
  const obj = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const circuitState = obj.circuitState === 'open' || obj.circuitState === 'half-open' ? obj.circuitState : 'closed';

  return {
    serverId,
    circuitState,
    lastSuccessAt: toNullableNumber(obj.lastSuccessAt),
    lastFailureAt: toNullableNumber(obj.lastFailureAt),
    consecutiveFailures: Math.max(0, toNumber(obj.consecutiveFailures)),
    consecutiveSuccesses: Math.max(0, toNumber(obj.consecutiveSuccesses)),
    totalCalls: Math.max(0, toNumber(obj.totalCalls)),
    totalFailures: Math.max(0, toNumber(obj.totalFailures)),
    totalSuccesses: Math.max(0, toNumber(obj.totalSuccesses)),
    avgLatencyMs: Math.max(0, toNumber(obj.avgLatencyMs)),
    p95LatencyMs: Math.max(0, toNumber(obj.p95LatencyMs)),
    lastError: toStringOrNull(obj.lastError),
    lastErrorAt: toNullableNumber(obj.lastErrorAt)
  };
}

function sanitizeMetrics(value: unknown): McpHealthMetrics | null {
  if (typeof value !== 'object' || value === null) return null;

  const obj = value as Record<string, unknown>;
  const rawServers = typeof obj.servers === 'object' && obj.servers !== null ? (obj.servers as Record<string, unknown>) : {};

  const servers = {
    mevzuat: sanitizeServerHealth('mevzuat', rawServers.mevzuat),
    borsa: sanitizeServerHealth('borsa', rawServers.borsa),
    yargi: sanitizeServerHealth('yargi', rawServers.yargi)
  };

  return {
    servers,
    globalTotalCalls: Math.max(0, toNumber(obj.globalTotalCalls)),
    globalTotalFailures: Math.max(0, toNumber(obj.globalTotalFailures)),
    globalAvgLatencyMs: Math.max(0, toNumber(obj.globalAvgLatencyMs)),
    updatedAt: Math.max(0, toNumber(obj.updatedAt, Date.now()))
  };
}

export function readMcpHealthSnapshotSync(filePath: string): McpHealthMetrics | null {
  try {
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as JsonValue;
    return sanitizeMetrics(parsed);
  } catch {
    return null;
  }
}

export async function writeMcpHealthSnapshot(filePath: string, metrics: McpHealthMetrics): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });

  const tmpPath = `${filePath}.tmp`;
  const payload = JSON.stringify(metrics, null, 2);

  await fsp.writeFile(tmpPath, payload, 'utf-8');
  await fsp.rename(tmpPath, filePath);
}

export const __private__ = {
  sanitizeMetrics,
  sanitizeServerHealth
};
