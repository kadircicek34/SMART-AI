import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { securityAuditLog } from '../../security/audit-log.js';
import {
  getEffectiveModelPolicy,
  resetTenantModelPolicy,
  setTenantModelPolicy
} from '../../security/model-policy.js';

const UpdateModelPolicySchema = z.object({
  defaultModel: z.string().min(1),
  allowedModels: z.array(z.string().min(1)).min(1)
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
    updated_at: policy.updatedAt
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

    const result = await setTenantModelPolicy(tenantId, parsed.data);
    if (!result.ok) {
      securityAuditLog.record({
        tenant_id: tenantId,
        type: 'model_policy_change_rejected',
        ip: req.ip,
        request_id: req.requestContext?.requestId,
        details: {
          reason: result.code
        }
      });

      return reply.status(result.statusCode).send({
        error: {
          type: result.statusCode === 403 ? 'permission_error' : 'invalid_request_error',
          message: result.reason
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
        default_model: result.policy.defaultModel
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

    const existed = await resetTenantModelPolicy(tenantId);
    if (existed) {
      securityAuditLog.record({
        tenant_id: tenantId,
        type: 'model_policy_reset',
        ip: req.ip,
        request_id: req.requestContext?.requestId,
        details: {
          reason: 'reset_to_deployment_defaults'
        }
      });
    }

    const policy = await getEffectiveModelPolicy(tenantId);
    return {
      reset: existed,
      ...mapPolicy(policy)
    };
  });
}
