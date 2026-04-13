import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

let modelPolicyModule: typeof import('../../security/model-policy.js');

before(async () => {
  process.env.MODEL_POLICY_FILE = `/tmp/smart-ai-test-model-policy-security-${process.pid}.json`;
  process.env.OPENROUTER_ALLOWED_MODELS = 'deepseek/deepseek-chat-v3.1,google/gemini-2.5-flash,openai/gpt-4o-mini';
  process.env.OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-chat-v3.1';
  process.env.OPENROUTER_REASONING_MODELS = 'deepseek/deepseek-chat-v3.1,google/gemini-2.5-flash';
  process.env.OPENROUTER_MAX_TENANT_ALLOWED_MODELS = '3';

  await fs.writeFile(
    process.env.MODEL_POLICY_FILE,
    JSON.stringify(
      {
        tenants: {
          'tenant-invalid-policy': {
            allowedModels: ['deepseek/deepseek-v3.2'],
            defaultModel: 'deepseek/deepseek-v3.2',
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
    defaultModel: 'deepseek/deepseek-chat-v3.1',
    allowedModels: ['deepseek/deepseek-chat-v3.1', 'deepseek/deepseek-chat-v3.1']
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.allowedModels, ['deepseek/deepseek-chat-v3.1']);
  }
});

test('getEffectiveModelPolicy fails closed when stored tenant policy falls outside deployment allowlist and keeps legacy revision metadata', async () => {
  const policy = await modelPolicyModule.getEffectiveModelPolicy('tenant-invalid-policy');

  assert.equal(policy.source, 'tenant');
  assert.equal(policy.policyStatus, 'invalid');
  assert.deepEqual(policy.allowedModels, []);
  assert.equal(policy.defaultModel, null);
  assert.equal(policy.revision, 1);
  assert.equal(policy.lastChangeKind, 'override');
});

test('previewTenantModelPolicyChange raises high risk when all reasoning-capable models would be removed', async () => {
  const result = await modelPolicyModule.previewTenantModelPolicyChange('tenant-preview-security', {
    defaultModel: 'openai/gpt-4o-mini',
    allowedModels: ['openai/gpt-4o-mini']
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.preview.risk.level, 'high');
    assert.equal(result.preview.reasoning.defaultModelReasoningEnabled, false);
    assert.ok(result.preview.risk.reasons.some((reason) => /reasoning-capable/i.test(reason)));
  }
});

test('resetTenantModelPolicy keeps inherited deployment posture while preserving optimistic-concurrency revision', async () => {
  const saved = await modelPolicyModule.setTenantModelPolicy(
    'tenant-reset-revision',
    {
      defaultModel: 'google/gemini-2.5-flash',
      allowedModels: ['google/gemini-2.5-flash']
    },
    {
      expectedRevision: 0,
      changeReason: 'Tek reasoning model ile geçici tenant override oluşturuluyor.',
      actor: { principalName: 'unit-admin', authMode: 'api_key' }
    }
  );

  assert.equal(saved.ok, true);
  if (!saved.ok) {
    return;
  }

  const reset = await modelPolicyModule.resetTenantModelPolicy('tenant-reset-revision', {
    expectedRevision: 1,
    changeReason: 'Override kaldırılıyor ve deployment defaultlarına dönülüyor.',
    actor: { principalName: 'unit-admin', authMode: 'api_key' }
  });

  assert.equal(reset.ok, true);
  if (!reset.ok) {
    return;
  }

  assert.equal(reset.reset, true);
  const effective = await modelPolicyModule.getEffectiveModelPolicy('tenant-reset-revision');
  assert.equal(effective.source, 'deployment');
  assert.equal(effective.policyStatus, 'inherited');
  assert.equal(effective.revision, 2);
  assert.equal(effective.lastChangeKind, 'reset');
  assert.equal(effective.changeReason, 'Override kaldırılıyor ve deployment defaultlarına dönülüyor.');
});
