import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunOutput } from '../../orchestrator/types.js';
import {
  __private__,
  cancelResearchJob,
  enqueueResearchJob,
  getResearchJob,
  type ResearchJob
} from '../../worker/jobs.js';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

const stubRunnerOutput: RunOutput = {
  text: 'stub-result',
  finishReason: 'stop',
  model: 'stub-model',
  usage: {
    promptTokens: 1,
    completionTokens: 1,
    totalTokens: 2
  },
  toolResults: [],
  plan: {
    objective: 'stub',
    tools: [],
    reasoning: 'stub'
  }
};

async function waitFor(
  predicate: () => boolean,
  opts: {
    timeoutMs?: number;
    stepMs?: number;
    message?: string;
  } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 500;
  const stepMs = opts.stepMs ?? 10;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }

  throw new Error(opts.message ?? 'waitFor timeout');
}

beforeEach(() => {
  __private__.resetStoreForTests();
  __private__.setJobRunnerForTests();
});

afterEach(() => {
  __private__.setJobRunnerForTests();
  __private__.resetStoreForTests();
});

test('enqueueResearchJob reuses existing job when Idempotency-Key matches same payload', async () => {
  const gate = createDeferred<typeof stubRunnerOutput>();
  let runnerCalls = 0;

  __private__.setJobRunnerForTests(async () => {
    runnerCalls += 1;
    return gate.promise;
  });

  const first = enqueueResearchJob({
    tenantId: 'tenant-worker-idempotency',
    model: 'deepseek/deepseek-chat-v3.1',
    query: 'Aynı job tekrar edilmesin',
    idempotencyKey: 'idempo-001',
    maxActiveJobsPerTenant: 2,
    idempotencyTtlSeconds: 3600,
    jobTimeoutMs: 5_000,
    maxJobsPerTenant: 500
  });

  const second = enqueueResearchJob({
    tenantId: 'tenant-worker-idempotency',
    model: 'deepseek/deepseek-chat-v3.1',
    query: 'Aynı job tekrar edilmesin',
    idempotencyKey: 'idempo-001',
    maxActiveJobsPerTenant: 2,
    idempotencyTtlSeconds: 3600,
    jobTimeoutMs: 5_000,
    maxJobsPerTenant: 500
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  if (!first.ok || !second.ok) return;

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.job.id, first.job.id);

  await waitFor(() => runnerCalls === 1, {
    message: 'runner should be called only once for idempotent replay'
  });

  gate.resolve(stubRunnerOutput);

  await waitFor(() => getResearchJob(first.job.id)?.status === 'completed', {
    message: 'job should complete after runner resolve'
  });
});

test('enqueueResearchJob rejects idempotency key conflicts when payload differs', async () => {
  const gate = createDeferred<typeof stubRunnerOutput>();

  __private__.setJobRunnerForTests(async () => gate.promise);

  const first = enqueueResearchJob({
    tenantId: 'tenant-worker-idempotency-conflict',
    model: 'deepseek/deepseek-chat-v3.1',
    query: 'ilk payload',
    idempotencyKey: 'idempo-conflict',
    maxActiveJobsPerTenant: 2,
    idempotencyTtlSeconds: 3600,
    jobTimeoutMs: 5_000,
    maxJobsPerTenant: 500
  });

  const second = enqueueResearchJob({
    tenantId: 'tenant-worker-idempotency-conflict',
    model: 'deepseek/deepseek-chat-v3.1',
    query: 'farklı payload',
    idempotencyKey: 'idempo-conflict',
    maxActiveJobsPerTenant: 2,
    idempotencyTtlSeconds: 3600,
    jobTimeoutMs: 5_000,
    maxJobsPerTenant: 500
  });

  assert.equal(first.ok, true);
  assert.deepEqual(second, { ok: false, reason: 'idempotency_conflict' });

  gate.resolve(stubRunnerOutput);
});

test('enqueueResearchJob expires idempotency key after TTL window', async () => {
  const gate = createDeferred<typeof stubRunnerOutput>();

  __private__.setJobRunnerForTests(async () => gate.promise);

  const first = enqueueResearchJob({
    tenantId: 'tenant-worker-idempotency-ttl',
    model: 'deepseek/deepseek-chat-v3.1',
    query: 'aynı key ama ttl sonrası yeni job',
    idempotencyKey: 'idempo-ttl',
    maxActiveJobsPerTenant: 3,
    idempotencyTtlSeconds: 3600,
    jobTimeoutMs: 5_000,
    maxJobsPerTenant: 500
  });

  assert.equal(first.ok, true);
  if (!first.ok) return;

  await waitFor(() => getResearchJob(first.job.id)?.status === 'running');

  gate.resolve(stubRunnerOutput);

  await waitFor(() => getResearchJob(first.job.id)?.status === 'completed');

  __private__.pruneExpiredIdempotencyEntries(0);

  const second = enqueueResearchJob({
    tenantId: 'tenant-worker-idempotency-ttl',
    model: 'deepseek/deepseek-chat-v3.1',
    query: 'aynı key ama ttl sonrası yeni job',
    idempotencyKey: 'idempo-ttl',
    maxActiveJobsPerTenant: 3,
    idempotencyTtlSeconds: 3600,
    jobTimeoutMs: 5_000,
    maxJobsPerTenant: 500
  });

  assert.equal(second.ok, true);
  if (!second.ok) return;

  assert.notEqual(second.job.id, first.job.id);
});

test('enqueueResearchJob enforces maxActiveJobsPerTenant limit', async () => {
  const gate = createDeferred<typeof stubRunnerOutput>();

  __private__.setJobRunnerForTests(async () => gate.promise);

  const first = enqueueResearchJob({
    tenantId: 'tenant-worker-limit',
    model: 'deepseek/deepseek-chat-v3.1',
    query: 'job-1',
    maxActiveJobsPerTenant: 1,
    idempotencyTtlSeconds: 3600,
    jobTimeoutMs: 5_000,
    maxJobsPerTenant: 500
  });

  const second = enqueueResearchJob({
    tenantId: 'tenant-worker-limit',
    model: 'deepseek/deepseek-chat-v3.1',
    query: 'job-2',
    maxActiveJobsPerTenant: 1,
    idempotencyTtlSeconds: 3600,
    jobTimeoutMs: 5_000,
    maxJobsPerTenant: 500
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);

  if (second.ok) return;

  assert.equal(second.reason, 'active_limit_exceeded');
  assert.equal(second.activeJobs, 1);

  gate.resolve(stubRunnerOutput);
});

test('cancelResearchJob keeps cancelled status even if runner finishes later', async () => {
  const gate = createDeferred<typeof stubRunnerOutput>();

  __private__.setJobRunnerForTests(async () => gate.promise);

  const created = enqueueResearchJob({
    tenantId: 'tenant-worker-cancel',
    model: 'deepseek/deepseek-chat-v3.1',
    query: 'uzun süren araştırma',
    maxActiveJobsPerTenant: 2,
    idempotencyTtlSeconds: 3600,
    jobTimeoutMs: 5_000,
    maxJobsPerTenant: 500
  });

  assert.equal(created.ok, true);
  if (!created.ok) return;

  await waitFor(() => {
    const job = getResearchJob(created.job.id);
    return job?.status === 'running';
  });

  const cancelled = cancelResearchJob(created.job.id, 'tenant-worker-cancel');
  assert.ok(cancelled);
  assert.equal(cancelled?.status, 'cancelled');

  gate.resolve(stubRunnerOutput);

  await waitFor(() => {
    const job = getResearchJob(created.job.id);
    return job?.status === 'cancelled';
  });

  const latest = getResearchJob(created.job.id) as ResearchJob;
  assert.equal(latest.status, 'cancelled');
  assert.equal(latest.result, undefined);
});

test('job timeout aborts long-running work and marks cancellation reason', async () => {
  __private__.setJobRunnerForTests(async ({ signal }) => {
    await new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }

      const timer = setTimeout(resolve, 5_000);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true }
      );
    });

    return stubRunnerOutput;
  });

  const created = enqueueResearchJob({
    tenantId: 'tenant-worker-timeout',
    model: 'deepseek/deepseek-chat-v3.1',
    query: 'uzun görev',
    maxActiveJobsPerTenant: 2,
    idempotencyTtlSeconds: 3600,
    jobTimeoutMs: 1_000,
    maxJobsPerTenant: 500
  });

  assert.equal(created.ok, true);
  if (!created.ok) return;

  await waitFor(() => getResearchJob(created.job.id)?.status === 'cancelled', {
    timeoutMs: 2_500,
    message: 'timed out job should become cancelled'
  });

  const timedOut = getResearchJob(created.job.id);
  assert.equal(timedOut?.status, 'cancelled');
  assert.equal(timedOut?.cancellationReason, 'timeout');
});

test('job failure errors are redacted before being persisted', async () => {
  __private__.setJobRunnerForTests(async () => {
    throw new Error('provider rejected key sk-or-v1-1234567890 and Authorization: Bearer super-secret-token');
  });

  const created = enqueueResearchJob({
    tenantId: 'tenant-worker-redact',
    model: 'deepseek/deepseek-chat-v3.1',
    query: 'hata üret',
    maxActiveJobsPerTenant: 2,
    idempotencyTtlSeconds: 3600,
    jobTimeoutMs: 5_000,
    maxJobsPerTenant: 500
  });

  assert.equal(created.ok, true);
  if (!created.ok) return;

  await waitFor(() => {
    const job = getResearchJob(created.job.id);
    return job?.status === 'failed';
  });

  const failed = getResearchJob(created.job.id);
  assert.ok(failed?.error);
  assert.match(failed?.error ?? '', /redacted/i);
  assert.doesNotMatch(failed?.error ?? '', /sk-or-v1-1234567890/);
  assert.doesNotMatch(failed?.error ?? '', /super-secret-token/);
});
