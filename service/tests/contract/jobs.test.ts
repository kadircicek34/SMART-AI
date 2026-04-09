import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { RunOutput } from '../../orchestrator/types.js';

let app: FastifyInstance;
let workerModule: typeof import('../../worker/jobs.js');
let pendingResolves: Array<(value: RunOutput) => void> = [];

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
  },
  verification: {
    evidence: {
      sufficient: true,
      confidence: 1,
      reason: 'stub'
    },
    simplicity: {
      score: 0.95,
      level: 'clean',
      reasons: [],
      threshold: 0.58,
      belowThreshold: false
    }
  }
};

function authHeaders(tenantId = 'tenant-jobs') {
  return {
    authorization: 'Bearer test-api-key',
    'x-tenant-id': tenantId
  };
}

before(async () => {
  process.env.APP_API_KEYS = 'test-api-key';
  process.env.KEY_STORE_FILE = `/tmp/smart-ai-test-keys-jobs-${process.pid}.json`;
  process.env.MODEL_POLICY_FILE = `/tmp/smart-ai-test-model-policy-jobs-${process.pid}.json`;
  process.env.OPENROUTER_ALLOWED_MODELS = 'deepseek/deepseek-v3.2,openai/gpt-4o-mini';
  process.env.OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-v3.2';
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 4).toString('base64');
  process.env.RESEARCH_MAX_ACTIVE_JOBS_PER_TENANT = '1';

  workerModule = await import('../../worker/jobs.js');
  workerModule.__private__.setJobRunnerForTests(async () => {
    return await new Promise((resolve) => {
      pendingResolves.push(resolve);
    });
  });

  const mod = await import('../../api/app.js');
  app = mod.buildApp();
});

beforeEach(() => {
  workerModule.__private__.resetStoreForTests();
  pendingResolves = [];
});

afterEach(async () => {
  while (pendingResolves.length) {
    const resolve = pendingResolves.shift();
    resolve?.(stubRunnerOutput);
  }

  await new Promise((resolve) => setTimeout(resolve, 5));
});

after(async () => {
  workerModule.__private__.setJobRunnerForTests();
  workerModule.__private__.resetStoreForTests();
  await app.close();
});

test('POST /v1/jobs/research supports idempotent replay for identical payload', async () => {
  const first = await app.inject({
    method: 'POST',
    url: '/v1/jobs/research',
    headers: {
      ...authHeaders(),
      'idempotency-key': 'same-request-001'
    },
    payload: {
      query: 'Aynı istek tekrar edilirse aynı job dönsün'
    }
  });

  assert.equal(first.statusCode, 202);
  const firstBody = first.json();
  assert.equal(firstBody.idempotencyReused, false);

  const second = await app.inject({
    method: 'POST',
    url: '/v1/jobs/research',
    headers: {
      ...authHeaders(),
      'idempotency-key': 'same-request-001'
    },
    payload: {
      query: 'Aynı istek tekrar edilirse aynı job dönsün'
    }
  });

  assert.equal(second.statusCode, 200);
  const secondBody = second.json();
  assert.equal(secondBody.idempotencyReused, true);
  assert.equal(secondBody.id, firstBody.id);
});

test('POST /v1/jobs/research rejects idempotency conflicts with different payload', async () => {
  const first = await app.inject({
    method: 'POST',
    url: '/v1/jobs/research',
    headers: {
      ...authHeaders('tenant-jobs-conflict'),
      'idempotency-key': 'idempo-conflict'
    },
    payload: {
      query: 'ilk payload'
    }
  });

  assert.equal(first.statusCode, 202);

  const second = await app.inject({
    method: 'POST',
    url: '/v1/jobs/research',
    headers: {
      ...authHeaders('tenant-jobs-conflict'),
      'idempotency-key': 'idempo-conflict'
    },
    payload: {
      query: 'farklı payload'
    }
  });

  assert.equal(second.statusCode, 409);
  const body = second.json();
  assert.equal(body.error.type, 'invalid_request_error');
});

test('POST /v1/jobs/research enforces active job cap per tenant', async () => {
  const first = await app.inject({
    method: 'POST',
    url: '/v1/jobs/research',
    headers: authHeaders('tenant-jobs-limit'),
    payload: {
      query: 'job-1'
    }
  });

  assert.equal(first.statusCode, 202);

  const second = await app.inject({
    method: 'POST',
    url: '/v1/jobs/research',
    headers: authHeaders('tenant-jobs-limit'),
    payload: {
      query: 'job-2'
    }
  });

  assert.equal(second.statusCode, 429);
  const body = second.json();
  assert.equal(body.error.type, 'rate_limit_error');
});

test('GET /v1/jobs and POST /v1/jobs/:jobId/cancel manage tenant-scoped lifecycle', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/jobs/research',
    headers: authHeaders('tenant-jobs-cancel'),
    payload: {
      query: 'uzun araştırma'
    }
  });

  assert.equal(created.statusCode, 202);
  const createdBody = created.json();

  const listRes = await app.inject({
    method: 'GET',
    url: '/v1/jobs?limit=10',
    headers: authHeaders('tenant-jobs-cancel')
  });

  assert.equal(listRes.statusCode, 200);
  const listBody = listRes.json();
  assert.equal(listBody.object, 'list');
  assert.ok(Array.isArray(listBody.data));
  assert.ok(listBody.data.some((job: any) => job.id === createdBody.id));

  const cancelRes = await app.inject({
    method: 'POST',
    url: `/v1/jobs/${createdBody.id}/cancel`,
    headers: authHeaders('tenant-jobs-cancel')
  });

  assert.equal(cancelRes.statusCode, 200);
  const cancelBody = cancelRes.json();
  assert.equal(cancelBody.status, 'cancelled');
  assert.equal(cancelBody.cancelled, true);

  const detailRes = await app.inject({
    method: 'GET',
    url: `/v1/jobs/${createdBody.id}`,
    headers: authHeaders('tenant-jobs-cancel')
  });

  assert.equal(detailRes.statusCode, 200);
  const detailBody = detailRes.json();
  assert.equal(detailBody.status, 'cancelled');
});

test('POST /v1/jobs/research rejects disallowed model', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/jobs/research',
    headers: authHeaders('tenant-jobs-model-reject'),
    payload: {
      query: 'test query',
      model: 'openrouter/agentic-default'
    }
  });

  assert.equal(res.statusCode, 403);
  const body = res.json();
  assert.equal(body.error.type, 'permission_error');
});

test('POST /v1/jobs/research uses tenant default model when request omits model', async () => {
  const policyRes = await app.inject({
    method: 'PUT',
    url: '/v1/model-policy',
    headers: {
      ...authHeaders('tenant-jobs-default-model'),
      'content-type': 'application/json'
    },
    payload: {
      defaultModel: 'openai/gpt-4o-mini',
      allowedModels: ['openai/gpt-4o-mini']
    }
  });

  assert.equal(policyRes.statusCode, 200);

  const created = await app.inject({
    method: 'POST',
    url: '/v1/jobs/research',
    headers: authHeaders('tenant-jobs-default-model'),
    payload: {
      query: 'default model ile job oluştur'
    }
  });

  assert.equal(created.statusCode, 202);
  const body = created.json();
  assert.equal(body.model, 'openai/gpt-4o-mini');
});

test('POST /v1/jobs/research validates Idempotency-Key header format', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/jobs/research',
    headers: {
      ...authHeaders('tenant-jobs-idempo-invalid'),
      'idempotency-key': 'invalid key with spaces'
    },
    payload: {
      query: 'test query'
    }
  });

  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error.type, 'invalid_request_error');
});
