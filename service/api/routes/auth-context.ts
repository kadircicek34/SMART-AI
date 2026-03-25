import type { FastifyInstance } from 'fastify';
import { describeAuthPermissions } from '../../security/authz.js';

function authError() {
  return {
    error: {
      type: 'authentication_error',
      message: 'Unauthorized tenant context.'
    }
  };
}

export async function registerAuthContextRoute(app: FastifyInstance) {
  app.get('/v1/auth/context', async (req, reply) => {
    const context = req.requestContext;
    if (!context) {
      return reply.status(401).send(authError());
    }

    const permissions = describeAuthPermissions(context.authScopes);

    return {
      object: 'auth_context',
      tenant_id: context.tenantId,
      auth_mode: context.authMode,
      principal_name: context.authPrincipalName,
      scopes: context.authScopes,
      permissions: {
        read: permissions.canRead,
        operate: permissions.canOperate,
        admin: permissions.canAdmin
      }
    };
  });
}
