import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

let modelPolicyModule: typeof import('../../security/model-policy.js');

before(async () => {
  process.env.MODEL_POLICY_FILE = `/tmp/smart-ai-test-model-policy-security-${process.pid}.json`;
  process.env.OPENROUTER_ALLOWED_MODELS = 'deepseek/deepseek-v3.2';
  process.env.OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-v3.2';
  process.env.OPENROUTER_MAX_TENANT_ALLOWED_MODELS = '2';

  await fs.writeFile(
    process.env.MODEL_POLICY_FILE,
    JSON.stringify(
      {
        tenants: {
          'tenant-invalid-policy': {
            allowedModels: ['openai/gpt-4o-mini'],
            defaultModel: 'openai/gpt-4o-mini',
            updatedAt: new Date().toISOString()
          }
        }
      },
      null,
      2
    ),
    'utf8'
  );

  modelPolicyModule = await import('../../security/model-policy.js');
});

test('validateTenantModelPolicyInput dedupes allowedModels and preserves a valid default', () => {
  const result = modelPolicyModule.validateTenantModelPolicyInput({
    defaultModel: 'deepseek/deepseek-v3.2',
    allowedModels: ['deepseek/deepseek-v3.2', 'deepseek/deepseek-v3.2']
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.allowedModels, ['deepseek/deepseek-v3.2']);
  }
});

test('getEffectiveModelPolicy fails closed when stored tenant policy falls outside deployment allowlist', async () => {
  const policy = await modelPolicyModule.getEffectiveModelPolicy('tenant-invalid-policy');

  assert.equal(policy.source, 'tenant');
  assert.equal(policy.policyStatus, 'invalid');
  assert.deepEqual(policy.allowedModels, []);
  assert.equal(policy.defaultModel, null);
});

test('resolveTenantModel rejects requests when tenant policy has no effective allowed models', async () => {
  const result = await modelPolicyModule.resolveTenantModel('tenant-invalid-policy', 'openai/gpt-4o-mini');

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.statusCode, 403);
    assert.equal(result.auditReason, 'tenant_policy_invalid');
  }
});
