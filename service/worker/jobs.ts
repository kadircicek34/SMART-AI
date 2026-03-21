import crypto from 'node:crypto';
import { runOrchestrator } from '../orchestrator/run.js';
import { securityAuditLog } from '../security/audit-log.js';
import { isAbortError } from '../utils/abort.js';

type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
type JobCancellationReason = 'user_cancelled' | 'timeout' | 'system_abort';

type JobRunnerInput = Parameters<typeof runOrchestrator>[0];
type JobRunnerOutput = Awaited<ReturnType<typeof runOrchestrator>>;
type JobRunner = (input: JobRunnerInput) => Promise<JobRunnerOutput>;

type IdempotencyIndexEntry = {
  jobId: string;
  createdAt: number;
};

export type ResearchJob = {
  id: string;
  tenantId: string;
  model: string;
  query: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  status: JobStatus;
  result?: string;
  error?: string;
  idempotencyKeyHash?: string;
  idempotencyPayloadHash?: string;
  cancelledAt?: number;
  cancellationReason?: JobCancellationReason;
};

export type EnqueueResearchJobResult =
  | { ok: true; job: ResearchJob; reused: boolean }
  | { ok: false; reason: 'active_limit_exceeded'; activeJobs: number }
  | { ok: false; reason: 'idempotency_conflict' };

const jobs = new Map<string, ResearchJob>();
const tenantJobs = new Map<string, Set<string>>();
const idempotencyIndex = new Map<string, IdempotencyIndexEntry>();
const jobControllers = new Map<string, AbortController>();
const jobTimeoutHandles = new Map<string, NodeJS.Timeout>();

let jobRunner: JobRunner = runOrchestrator;

function digest(input: string): string {
  return crypto.createHash('sha256').update(input).digest('base64url');
}

function idempotencyLookupKey(tenantId: string, idempotencyKeyHash: string): string {
  return `${tenantId}:${idempotencyKeyHash}`;
}

function isTerminal(job: ResearchJob): boolean {
  return job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
}

function markCancelled(job: ResearchJob, reason: JobCancellationReason): void {
  const now = Date.now();
  job.status = 'cancelled';
  job.cancelledAt = now;
  job.cancellationReason = reason;
  job.updatedAt = now;
}

function clearJobExecutionHandles(jobId: string): void {
  const timeout = jobTimeoutHandles.get(jobId);
  if (timeout) {
    clearTimeout(timeout);
  }

  jobTimeoutHandles.delete(jobId);
  jobControllers.delete(jobId);
}

function removeJob(jobId: string): void {
  const job = jobs.get(jobId);
  if (!job) return;

  clearJobExecutionHandles(jobId);
  jobs.delete(jobId);

  const bucket = tenantJobs.get(job.tenantId);
  if (bucket) {
    bucket.delete(jobId);
    if (bucket.size === 0) {
      tenantJobs.delete(job.tenantId);
    }
  }

  if (job.idempotencyKeyHash) {
    idempotencyIndex.delete(idempotencyLookupKey(job.tenantId, job.idempotencyKeyHash));
  }
}

function pruneExpiredIdempotencyEntries(ttlMs: number): void {
  const now = Date.now();

  for (const [lookupKey, entry] of idempotencyIndex.entries()) {
    const expired = now - entry.createdAt > ttlMs;
    if (expired || !jobs.has(entry.jobId)) {
      idempotencyIndex.delete(lookupKey);
    }
  }
}

function pruneTenantJobs(tenantId: string, maxJobsPerTenant: number): void {
  const bucket = tenantJobs.get(tenantId);
  if (!bucket) return;

  const safeLimit = Math.max(50, maxJobsPerTenant);
  if (bucket.size <= safeLimit) return;

  const candidates = [...bucket]
    .map((id) => jobs.get(id))
    .filter((job): job is ResearchJob => Boolean(job))
    .filter((job) => isTerminal(job))
    .sort((a, b) => a.createdAt - b.createdAt);

  let overflow = bucket.size - safeLimit;
  for (const candidate of candidates) {
    if (overflow <= 0) break;
    removeJob(candidate.id);
    overflow -= 1;
  }
}

function registerJob(job: ResearchJob, opts: { maxJobsPerTenant: number }): void {
  jobs.set(job.id, job);

  const bucket = tenantJobs.get(job.tenantId) ?? new Set<string>();
  bucket.add(job.id);
  tenantJobs.set(job.tenantId, bucket);

  if (job.idempotencyKeyHash) {
    idempotencyIndex.set(idempotencyLookupKey(job.tenantId, job.idempotencyKeyHash), {
      jobId: job.id,
      createdAt: job.createdAt
    });
  }

  pruneTenantJobs(job.tenantId, opts.maxJobsPerTenant);
}

function countTenantActiveJobs(tenantId: string): number {
  const ids = tenantJobs.get(tenantId);
  if (!ids) return 0;

  let active = 0;
  for (const id of ids) {
    const job = jobs.get(id);
    if (!job) continue;
    if (job.status === 'queued' || job.status === 'running') {
      active += 1;
    }
  }

  return active;
}

function sanitizeJobErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);

  message = message
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted-api-key]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted-token]')
    .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim();

  return message.length > 320 ? `${message.slice(0, 317)}...` : message;
}

export function enqueueResearchJob(params: {
  tenantId: string;
  model: string;
  query: string;
  openRouterApiKey?: string;
  idempotencyKey?: string;
  maxActiveJobsPerTenant: number;
  idempotencyTtlSeconds: number;
  jobTimeoutMs: number;
  maxJobsPerTenant: number;
}): EnqueueResearchJobResult {
  const idempotencyTtlMs = Math.max(30, params.idempotencyTtlSeconds) * 1000;
  pruneExpiredIdempotencyEntries(idempotencyTtlMs);

  const idempotencyKeyHash = params.idempotencyKey ? digest(params.idempotencyKey) : undefined;
  const payloadHash = digest(JSON.stringify({ model: params.model, query: params.query }));

  if (idempotencyKeyHash) {
    const indexKey = idempotencyLookupKey(params.tenantId, idempotencyKeyHash);
    const indexed = idempotencyIndex.get(indexKey);

    if (indexed) {
      const existing = jobs.get(indexed.jobId);
      if (existing) {
        if (existing.idempotencyPayloadHash && existing.idempotencyPayloadHash !== payloadHash) {
          return { ok: false, reason: 'idempotency_conflict' };
        }

        return { ok: true, job: existing, reused: true };
      }

      idempotencyIndex.delete(indexKey);
    }
  }

  const maxActive = Math.max(1, params.maxActiveJobsPerTenant);
  const activeJobs = countTenantActiveJobs(params.tenantId);
  if (activeJobs >= maxActive) {
    return { ok: false, reason: 'active_limit_exceeded', activeJobs };
  }

  const id = `job_${crypto.randomUUID().replace(/-/g, '')}`;

  const job: ResearchJob = {
    id,
    tenantId: params.tenantId,
    model: params.model,
    query: params.query,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'queued',
    idempotencyKeyHash,
    idempotencyPayloadHash: idempotencyKeyHash ? payloadHash : undefined
  };

  registerJob(job, {
    maxJobsPerTenant: params.maxJobsPerTenant
  });

  queueMicrotask(async () => {
    const current = jobs.get(id);
    if (!current || current.status === 'cancelled') return;

    const abortController = new AbortController();
    jobControllers.set(id, abortController);

    const timeoutMs = Math.max(1_000, params.jobTimeoutMs);
    const timeoutHandle = setTimeout(() => {
      const latest = jobs.get(id);
      if (!latest || isTerminal(latest)) return;

      markCancelled(latest, 'timeout');
      securityAuditLog.record({
        tenant_id: latest.tenantId,
        type: 'research_job_timed_out',
        details: {
          job_id: latest.id,
          timeout_ms: timeoutMs
        }
      });
      abortController.abort(new DOMException('Research job timed out', 'TimeoutError'));
    }, timeoutMs);

    jobTimeoutHandles.set(id, timeoutHandle);

    try {
      current.status = 'running';
      current.startedAt = Date.now();
      current.updatedAt = current.startedAt;

      const out = await jobRunner({
        tenantId: params.tenantId,
        model: params.model,
        openRouterApiKey: params.openRouterApiKey,
        messages: [{ role: 'user', content: params.query }],
        signal: abortController.signal
      });

      const latest = jobs.get(id);
      if (!latest || latest.status === 'cancelled') {
        return;
      }

      const doneAt = Date.now();
      latest.status = 'completed';
      latest.result = out.text;
      latest.completedAt = doneAt;
      latest.updatedAt = doneAt;
    } catch (error) {
      const latest = jobs.get(id);
      if (!latest || latest.status === 'cancelled') {
        return;
      }

      if (isAbortError(error)) {
        markCancelled(latest, 'system_abort');
        return;
      }

      latest.status = 'failed';
      latest.error = sanitizeJobErrorMessage(error);
      latest.updatedAt = Date.now();
      latest.completedAt = latest.updatedAt;
    } finally {
      clearJobExecutionHandles(id);
    }
  });

  return { ok: true, job, reused: false };
}

export function getResearchJob(jobId: string): ResearchJob | null {
  return jobs.get(jobId) ?? null;
}

export function listResearchJobs(tenantId: string, opts: { limit?: number; status?: JobStatus } = {}): ResearchJob[] {
  const ids = tenantJobs.get(tenantId);
  if (!ids) return [];

  const status = opts.status;
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));

  const list = [...ids]
    .map((id) => jobs.get(id))
    .filter((job): job is ResearchJob => Boolean(job))
    .filter((job) => (status ? job.status === status : true))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);

  return list;
}

export function cancelResearchJob(jobId: string, tenantId: string): ResearchJob | null {
  const job = jobs.get(jobId);
  if (!job || job.tenantId !== tenantId) {
    return null;
  }

  if (isTerminal(job)) {
    return job;
  }

  markCancelled(job, 'user_cancelled');

  const controller = jobControllers.get(jobId);
  controller?.abort(new DOMException('Research job cancelled by user', 'AbortError'));

  clearJobExecutionHandles(jobId);

  return job;
}

function resetStoreForTests(): void {
  for (const timeout of jobTimeoutHandles.values()) {
    clearTimeout(timeout);
  }

  jobs.clear();
  tenantJobs.clear();
  idempotencyIndex.clear();
  jobControllers.clear();
  jobTimeoutHandles.clear();
}

function setJobRunnerForTests(runner?: JobRunner): void {
  jobRunner = runner ?? runOrchestrator;
}

export const __private__ = {
  sanitizeJobErrorMessage,
  resetStoreForTests,
  setJobRunnerForTests,
  countTenantActiveJobs,
  pruneExpiredIdempotencyEntries,
  pruneTenantJobs
};
