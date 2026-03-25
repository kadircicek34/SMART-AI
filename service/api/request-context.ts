import type { AuthScope } from '../security/authz.js';

export type RequestContext = {
  tenantId: string;
  requestId: string;
  authApiKey: string;
  authMode: 'api_key' | 'ui_session';
  authPrincipalName: string;
  authScopes: AuthScope[];
  authRequiredScope: AuthScope;
};

declare module 'fastify' {
  interface FastifyRequest {
    requestContext?: RequestContext;
  }
}
