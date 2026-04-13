import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { securityAuditLog } from '../../security/audit-log.js';
import {
  getEffectiveModelPolicy,
  previewTenantModelPolicyChange,
  resetTenantModelPolicy,
  setTenantModelPolicy,
  type TenantModelPolicyPreview
} from '../../security/model-policy.js';

const UpdateModelPolicySchema = z.object({
  defaultModel: z.string().min(1),
  allowedModels: z.array(z.string().min(1)).min(1),
  expectedRevision: z.number().int().min(0),
  changeReason: z.string().trim().min(8).max(280)
});

const PreviewModelPolicySchema = z.object({
  defaultModel: z.string().min(1),
  allowedModels: z.array(z.string().min(1)).min(1)
});

const ResetModelPolicySchema = z.object({
  expectedRevision: z.number().int().min(0),
  changeReason: z.string().trim().min(8).max(280)
});

function authError() {
  return {
    error: {
      type: 'authentication_error',
      message: 'Unauthorized tenant context.'
    }
  };
}

function mapPolicy(policy: Awaited<ReturnType<typeof getEffectiveModelPolicy>>) {
  return {
    object: 'model_policy',
    tenant_id: policy.tenantId,
    source: policy.source,
    policy_status: policy.policyStatus,
    default_model: policy.defaultModel,
    allowed_models: policy.allowedModels,
    deployment_allowed_models: policy.deploymentAllowedModels,
    updated_at: policy.updatedAt,
    revision: policy.revision,
    updated_by: policy.updatedBy,
    updated_by_auth_mode: policy.updatedByAuthMode,
    change_reason: policy.changeReason,
    last_change_kind: policy.lastChangeKind,
    reasoning_allowed_models: policy.reasoningAllowedModels
  };
}

function mapPreview(preview: TenantModelPolicyPreview) {
  return {
    object: 'model_policy_preview',
    tenant_id: preview.tenantId,
    current_revision: preview.currentRevision,
    next_revision: preview.nextRevision,
    current_source: preview.currentSource,
    current_policy_status: preview.currentPolicyStatus,
    would_change: preview.wouldChange,
    change_kind: preview.changeKind,
    current_default_model: preview.currentDefaultModel,
    candidate_default_model: preview.candidateDefaultModel,
    candidate_policy: {
      allowed_models: preview.candidatePolicy.allowedModels,
      default_model: preview.candidatePolicy.defaultModel
    },
    diff: {
      added_models: preview.diff.addedModels,
      removed_models: preview.diff.removedModels,
      unchanged_models: preview.diff.unchangedModels,
      default_model_changed: preview.diff.defaultModelChanged
    },
    reasoning: {
      current_models: preview.reasoning.currentModels,
      candidate_models: preview.reasoning.candidateModels,
      removed_models: preview.reasoning.removedModels,
      remaining_models: preview.reasoning.remainingModels,
      default_model_reasoning_enabled: preview.reasoning.defaultModelReasoningEnabled
    },
    risk: preview.risk,
    warnings: preview.warnings
  };
}

export async function registerModelPolicyRoute(app: FastifyInstance) {
  app.get('/v1/model-policy', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const policy = await getEffectiveModelPolicy(tenantId);
    return mapPolicy(policy);
  });

  app.post('/v1/model-policy/preview', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = PreviewModelPolicySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid body for model policy preview.',
          details: parsed.error.flatten()
        }
      });
    }

    const preview = await previewTenantModelPolicyChange(tenantId, parsed.data);
    if (!preview.ok) {
      return reply.status(preview.statusCode).send({
        error: {
          type: preview.statusCode === 403 ? 'permission_error' : 'invalid_request_error',
          message: preview.reason
        }
      });
    }

    return mapPreview(preview.preview);
  });

  app.put('/v1/model-policy', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = UpdateModelPolicySchema.safeParse(req.body);
    if (!parsed.success) {
      securityAuditLog.record({
        tenant_id: tenantId,
        type: 'model_policy_change_rejected',
        ip: req.ip,
        request_id: req.requestContext?.requestId,
        details: {
          reason: 'invalid_body'
        }
      });

      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid body for model policy update.',
          details: parsed.error.flatten()
        }
      });
    }

    const result = await setTenantModelPolicy(
      tenantId,
      {
        defaultModel: parsed.data.defaultModel,
        allowedModels: parsed.data.allowedModels
      },
      {
        expectedRevision: parsed.data.expectedRevision,
        changeReason: parsed.data.changeReason,
        actor: {
          principalName: req.requestContext?.authPrincipalName,
          authMode: req.requestContext?.authMode
        }
      }
    );

    if (!result.ok) {
      securityAuditLog.record({
        tenant_id: tenantId,
        type: 'model_policy_change_rejected',
        ip: req.ip,
        request_id: req.requestContext?.requestId,
        details: {
          reason: result.code,
          ...(result.currentRevision !== undefined ? { current_revision: result.currentRevision } : {}),
          expected_revision: parsed.data.expectedRevision
        }
      });

      return reply.status(result.statusCode).send({
        error: {
          type: result.statusCode === 403 ? 'permission_error' : 'invalid_request_error',
          message: result.reason,
          ...(result.currentRevision !== undefined ? { details: { current_revision: result.currentRevision } } : {})
        }
      });
    }

    securityAuditLog.record({
      tenant_id: tenantId,
      type: 'model_policy_updated',
      ip: req.ip,
      request_id: req.requestContext?.requestId,
      details: {
        allowed_models: result.policy.allowedModels.length,
        default_model: result.policy.defaultModel ?? '—',
        revision: result.policy.revision,
        auth_mode: result.policy.updatedByAuthMode ?? 'unknown'
      }
    });

    const policy = await getEffectiveModelPolicy(tenantId);
    return mapPolicy(policy);
  });

  app.delete('/v1/model-policy', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = ResetModelPolicySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      securityAuditLog.record({
        tenant_id: tenantId,
        type: 'model_policy_change_rejected',
        ip: req.ip,
        request_id: req.requestContext?.requestId,
        details: {
          reason: 'invalid_reset_body'
        }
      });

      return reply.status(400).send({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid body for model policy reset.',
          details: parsed.error.flatten()
        }
      });
    }

    const result = await resetTenantModelPolicy(tenantId, {
      expectedRevision: parsed.data.expectedRevision,
      changeReason: parsed.data.changeReason,
      actor: {
        principalName: req.requestContext?.authPrincipalName,
        authMode: req.requestContext?.authMode
      }
    });

    if (!result.ok) {
      securityAuditLog.record({
        tenant_id: tenantId,
        type: 'model_policy_change_rejected',
        ip: req.ip,
        request_id: req.requestContext?.requestId,
        details: {
          reason: result.code,
          ...(result.currentRevision !== undefined ? { current_revision: result.currentRevision } : {}),
          expected_revision: parsed.data.expectedRevision
        }
      });

      return reply.status(result.statusCode).send({
        error: {
          type: result.statusCode === 403 ? 'permission_error' : 'invalid_request_error',
          message: result.reason,
          ...(result.currentRevision !== undefined ? { details: { current_revision: result.currentRevision } } : {})
        }
      });
    }

    if (result.reset && result.policy) {
      securityAuditLog.record({
        tenant_id: tenantId,
        type: 'model_policy_reset',
        ip: req.ip,
        request_id: req.requestContext?.requestId,
        details: {
          reason: 'reset_to_deployment_defaults',
          revision: result.policy.revision,
          auth_mode: result.policy.updatedByAuthMode ?? 'unknown'
        }
      });
    }

    const policy = await getEffectiveModelPolicy(tenantId);
    return {
      reset: result.reset,
      ...mapPolicy(policy)
    };
  });
}
