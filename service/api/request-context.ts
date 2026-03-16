export type RequestContext = {
  tenantId: string;
  requestId: string;
  authApiKey: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    requestContext?: RequestContext;
  }
}
