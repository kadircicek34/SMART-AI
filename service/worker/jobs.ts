import crypto from 'node:crypto';
import { runOrchestrator } from '../orchestrator/run.js';

type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

type JobRunnerInput = Parameters<typeof runOrchestrator>[0];
type JobRunnerOutput = Awaited<ReturnType<typeof runOrchestrator>>;
type JobRunner = (input: JobRunnerInput) => Promise<JobRunnerOutput>;

export type ResearchJob = {
  id: string;
  tenantId: string;
  model: string;
  query: string;
  createdAt: number;
  updatedAt: number;
  status: JobStatus;
  result?: string;
  error?: string;
  idempotencyKeyHash?: string;
  idempotencyPayloadHash?: string;
  cancelledAt?: number;
};

export type EnqueueResearchJobResult =
  | { ok: true; job: ResearchJob; reused: boolean }
  | { ok: false; reason: 'active_limit_exceeded'; activeJobs: number }
  | { ok: false; reason: 'idempotency_conflict' };

const jobs = new Map<string, ResearchJob>();
const tenantJobs = new Map<string, Set<string>>();
const idempotencyIndex = new Map<string, string>();

let jobRunner: JobRunner = runOrchestrator;

function digest(input: string): string {
  return crypto.createHash('sha256').update(input).digest('base64url');
}

function idempotencyLookupKey(tenantId: string, idempotencyKeyHash: string): string {
  return `${tenantId}:${idempotencyKeyHash}`;
}

function registerJob(job: ResearchJob): void {
  jobs.set(job.id, job);

  const bucket = tenantJobs.get(job.tenantId) ?? new Set<string>();
  bucket.add(job.id);
  tenantJobs.set(job.tenantId, bucket);

  if (job.idempotencyKeyHash) {
    idempotencyIndex.set(idempotencyLookupKey(job.tenantId, job.idempotencyKeyHash), job.id);
  }
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
}): EnqueueResearchJobResult {
  const idempotencyKeyHash = params.idempotencyKey ? digest(params.idempotencyKey) : undefined;
  const payloadHash = digest(JSON.stringify({ model: params.model, query: params.query }));

  if (idempotencyKeyHash) {
    const indexedJobId = idempotencyIndex.get(idempotencyLookupKey(params.tenantId, idempotencyKeyHash));
    if (indexedJobId) {
      const existing = jobs.get(indexedJobId);
      if (existing) {
        if (existing.idempotencyPayloadHash && existing.idempotencyPayloadHash !== payloadHash) {
          return { ok: false, reason: 'idempotency_conflict' };
        }

        return { ok: true, job: existing, reused: true };
      }
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

  registerJob(job);

  queueMicrotask(async () => {
    const current = jobs.get(id);
    if (!current || current.status === 'cancelled') return;

    try {
      current.status = 'running';
      current.updatedAt = Date.now();

      const out = await jobRunner({
        tenantId: params.tenantId,
        model: params.model,
        openRouterApiKey: params.openRouterApiKey,
        messages: [{ role: 'user', content: params.query }]
      });

      const latest = jobs.get(id);
      if (!latest || latest.status === 'cancelled') {
        return;
      }

      latest.status = 'completed';
      latest.result = out.text;
      latest.updatedAt = Date.now();
    } catch (error) {
      const latest = jobs.get(id);
      if (!latest || latest.status === 'cancelled') {
        return;
      }

      latest.status = 'failed';
      latest.error = sanitizeJobErrorMessage(error);
      latest.updatedAt = Date.now();
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

  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return job;
  }

  const now = Date.now();
  job.status = 'cancelled';
  job.cancelledAt = now;
  job.updatedAt = now;
  return job;
}

function resetStoreForTests(): void {
  jobs.clear();
  tenantJobs.clear();
  idempotencyIndex.clear();
}

function setJobRunnerForTests(runner?: JobRunner): void {
  jobRunner = runner ?? runOrchestrator;
}

export const __private__ = {
  sanitizeJobErrorMessage,
  resetStoreForTests,
  setJobRunnerForTests,
  countTenantActiveJobs
};
