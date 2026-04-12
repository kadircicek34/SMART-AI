import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import {
  SECURITY_AUDIT_EVENT_TYPES,
  securityAuditLog,
  verifySecurityAuditIntegrity,
  type SecurityAuditEvent,
  type SecurityAuditEventType,
  type SecurityAuditExportBundle
} from '../../security/audit-log.js';
import {
  ensureSignedSecurityAuditExportBundle,
  getSecurityExportJwksPath,
  securityExportSigningRegistry,
  SecurityExportSigningError,
  verifySecurityAuditExportBundleSignature
} from '../../security/export-signing.js';
import {
  acknowledgeSecurityExportDeliveryIncident,
  clearSecurityExportDeliveryIncident,
  requestSecurityExportDeliveryIncidentClear,
  SecurityExportDeliveryError,
  SecurityExportDeliveryIncidentError,
  deliverSecurityAuditExport,
  getSecurityExportDeliveryAnalytics,
  getSecurityExportDeliveryIncident,
  enqueueSecurityAuditExportDelivery,
  listSecurityExportDeliveryIncidents,
  listSecurityExportDeliveries,
  previewSecurityExportDeliveryTarget,
  redriveSecurityAuditExportDelivery
} from '../../security/export-delivery.js';
import {
  getEffectiveSecurityExportDeliveryPolicy,
  resetTenantSecurityExportDeliveryPolicy,
  setTenantSecurityExportDeliveryPolicy,
  type EffectiveSecurityExportDeliveryPolicy
} from '../../security/export-delivery-policy.js';
import {
  evaluateSecurityExportOperatorAuthorization,
  getEffectiveSecurityExportOperatorPolicy,
  resetTenantSecurityExportOperatorPolicy,
  setTenantSecurityExportOperatorPolicy,
  type EffectiveSecurityExportOperatorPolicy,
  type SecurityExportOperatorAction
} from '../../security/export-operator-policy.js';
import {
  approveSecurityExportOperatorDelegation,
  createSecurityExportOperatorDelegation,
  consumeSecurityExportOperatorDelegation,
  findActiveSecurityExportOperatorDelegation,
  getSecurityExportOperatorDelegation,
  listSecurityExportOperatorDelegations,
  revokeSecurityExportOperatorDelegation,
  type SecurityExportOperatorDelegation,
  type SecurityExportOperatorDelegationStatus
} from '../../security/export-operator-delegation.js';
import { uiSessionStore } from '../../security/ui-session-store.js';

const CHAIN_HASH_REGEX = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY_ALLOWED = /^[A-Za-z0-9._:-]+$/;

const LIST_QUERY_SCHEMA = z.object({
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 50;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 50;
      return parsed;
    })
    .refine((value) => value >= 1 && value <= 200, { message: 'limit must be between 1 and 200' }),
  type: z.enum(SECURITY_AUDIT_EVENT_TYPES).optional(),
  since: z.string().datetime().optional()
});

const SUMMARY_QUERY_SCHEMA = z.object({
  window_hours: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 24;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 24;
      return parsed;
    })
    .refine((value) => value >= 1 && value <= 24 * 30, { message: 'window_hours must be between 1 and 720' }),
  top_ip_limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 5;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 5;
      return parsed;
    })
    .refine((value) => value >= 1 && value <= 20, { message: 'top_ip_limit must be between 1 and 20' })
});

const EXPORT_QUERY_SCHEMA = z.object({
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 200;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 200;
      return parsed;
    })
    .refine((value) => value >= 1 && value <= 1000, { message: 'limit must be between 1 and 1000' }),
  since: z.string().datetime().optional(),
  top_ip_limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 5;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 5;
      return parsed;
    })
    .refine((value) => value >= 1 && value <= 20, { message: 'top_ip_limit must be between 1 and 20' })
});

const DELIVERY_LIST_QUERY_SCHEMA = z.object({
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 20;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 20;
      return parsed;
    })
    .refine((value) => value >= 1 && value <= 100, { message: 'limit must be between 1 and 100' }),
  status: z.enum(['queued', 'retrying', 'succeeded', 'failed', 'blocked', 'dead_letter']).optional()
});

const DELIVERY_ANALYTICS_QUERY_SCHEMA = z.object({
  window_hours: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return config.security.exportDeliveryIncidentWindowHours;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return config.security.exportDeliveryIncidentWindowHours;
      return parsed;
    })
    .refine((value) => value >= 1 && value <= 24 * 30, { message: 'window_hours must be between 1 and 720' }),
  bucket_hours: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 6;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 6;
      return parsed;
    })
    .refine((value) => value >= 1 && value <= 24 * 30, { message: 'bucket_hours must be between 1 and 720' }),
  destination_limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 10;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 10;
      return parsed;
    })
    .refine((value) => value >= 1 && value <= 50, { message: 'destination_limit must be between 1 and 50' })
});

const DELIVERY_INCIDENT_LIST_QUERY_SCHEMA = z.object({
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 20;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 20;
      return parsed;
    })
    .refine((value) => value >= 1 && value <= 100, { message: 'limit must be between 1 and 100' }),
  status: z.enum(['active', 'resolved']).optional()
});

const DELIVERY_REDIVE_PARAMS_SCHEMA = z.object({
  deliveryId: z.string().min(1).max(96)
});

const DELIVERY_INCIDENT_PARAMS_SCHEMA = z.object({
  incidentId: z.string().uuid()
});

const DELIVERY_INCIDENT_ACTION_BODY_SCHEMA = z.object({
  note: z.string().trim().min(8).max(280),
  revision: z.number().int().positive().optional()
});

const DELIVERY_POLICY_BODY_SCHEMA = z.object({
  mode: z.enum(['inherit_remote_policy', 'disabled', 'allowlist_only']),
  allowedTargets: z.array(z.string().min(1)).max(128).optional().default([])
});

const OPERATOR_POLICY_BODY_SCHEMA = z.object({
  mode: z.enum(['open_admins', 'roster_required']),
  roster: z.object({
    acknowledge: z.array(z.string().min(1)).max(128).optional().default([]),
    clear_request: z.array(z.string().min(1)).max(128).optional().default([]),
    clear_approve: z.array(z.string().min(1)).max(128).optional().default([])
  })
});

const OPERATOR_DELEGATION_LIST_QUERY_SCHEMA = z.object({
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 20;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 20;
      return parsed;
    })
    .refine((value) => value >= 1 && value <= 100, { message: 'limit must be between 1 and 100' }),
  status: z.enum(['pending_approval', 'active', 'consumed', 'revoked', 'expired', 'approval_expired']).optional()
});

const OPERATOR_DELEGATION_PARAMS_SCHEMA = z.object({
  grantId: z.string().uuid()
});

const OPERATOR_DELEGATION_BODY_SCHEMA = z.object({
  incidentId: z.string().uuid(),
  action: z.enum(['acknowledge', 'clear_request', 'clear_approve']),
  delegatePrincipal: z.string().trim().min(1).max(128),
  justification: z.string().trim().min(8).max(280),
  ttlMinutes: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return config.security.exportOperatorDelegationDefaultTtlMinutes;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return config.security.exportOperatorDelegationDefaultTtlMinutes;
      return parsed;
    })
    .refine((value) => value >= 1 && value <= config.security.exportOperatorDelegationMaxTtlMinutes, {
      message: `ttlMinutes must be between 1 and ${config.security.exportOperatorDelegationMaxTtlMinutes}`
    })
});

const OPERATOR_DELEGATION_APPROVE_BODY_SCHEMA = z.object({
  note: z.string().trim().min(8).max(280)
});

const OPERATOR_DELEGATION_REVOKE_BODY_SCHEMA = z.object({
  reason: z.string().trim().min(8).max(280)
});

const DELIVERY_PREVIEW_BODY_SCHEMA = z.object({
  destinationUrl: z.string().url().max(2048)
});

const SIGNING_POLICY_BODY_SCHEMA = z.object({
  auto_rotate: z.boolean(),
  rotate_after_hours: z.number().positive().max(24 * 365 * 5),
  expire_after_hours: z.number().positive().max(24 * 365 * 5),
  warn_before_hours: z.number().positive().max(24 * 365 * 5),
  verify_retention_hours: z.number().positive().max(24 * 365 * 5)
});

const SIGNING_MAINTENANCE_BODY_SCHEMA = z.object({
  dry_run: z.boolean().optional().default(false)
});

const DELIVERY_BODY_SCHEMA = z.object({
  destinationUrl: z.string().url().max(2048),
  mode: z.enum(['sync', 'async']).optional().default('sync'),
  since: z.string().datetime().optional(),
  windowHours: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 24;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 24;
      return parsed;
    })
    .refine((value) => value >= 1 && value <= 24 * 30, { message: 'windowHours must be between 1 and 720' }),
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 200;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 200;
      return parsed;
    })
    .refine((value) => value >= 1 && value <= 1000, { message: 'limit must be between 1 and 1000' }),
  topIpLimit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return 5;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 5;
      return parsed;
    })
    .refine((value) => value >= 1 && value <= 20, { message: 'topIpLimit must be between 1 and 20' })
});

const VERIFY_EVENT_SCHEMA: z.ZodType<SecurityAuditEvent> = z.object({
  event_id: z.string().min(1).max(96),
  tenant_id: z.string().min(1).max(128),
  type: z.enum(SECURITY_AUDIT_EVENT_TYPES),
  timestamp: z.string().datetime(),
  ip: z.string().max(72).optional(),
  request_id: z.string().max(96).optional(),
  details: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  sequence: z.number().int().positive(),
  prev_chain_hash: z.string().regex(CHAIN_HASH_REGEX).nullable(),
  chain_hash: z.string().regex(CHAIN_HASH_REGEX)
});

const VERIFY_SIGNATURE_SCHEMA = z.object({
  algorithm: z.literal('Ed25519'),
  key_id: z.string().min(1).max(96),
  signed_at: z.string().datetime(),
  payload_sha256: z.string().regex(CHAIN_HASH_REGEX),
  signature: z.string().min(40).max(512),
  public_keys_url: z.string().min(1).max(256)
});

const VERIFY_BUNDLE_SCHEMA = z.object({
  object: z.literal('security_audit_export'),
  tenant_id: z.string().min(1).max(128),
  generated_at: z.string().datetime(),
  filter: z.object({
    since: z.string().datetime().optional(),
    limit: z.number().int().positive().max(1000),
    truncated: z.boolean(),
    total_matching_events: z.number().int().nonnegative()
  }),
  summary: z.object({}).passthrough(),
  integrity: z.object({
    verified: z.boolean(),
    eventCount: z.number().int().nonnegative(),
    anchorPrevChainHash: z.string().regex(CHAIN_HASH_REGEX).nullable(),
    headChainHash: z.string().regex(CHAIN_HASH_REGEX).nullable(),
    lastSequence: z.number().int().positive().nullable(),
    firstEventId: z.string().nullable(),
    lastEventId: z.string().nullable(),
    brokenAtEventId: z.string().optional(),
    brokenAtSequence: z.number().int().positive().optional(),
    failureReason: z.enum(['prev_hash_mismatch', 'chain_hash_mismatch']).optional()
  }),
  data: z.array(VERIFY_EVENT_SCHEMA).max(1000),
  signature: VERIFY_SIGNATURE_SCHEMA.optional()
});

const VERIFY_BODY_SCHEMA = z.object({
  anchorPrevChainHash: z.string().regex(CHAIN_HASH_REGEX).nullable().optional(),
  events: z.array(VERIFY_EVENT_SCHEMA).max(1000)
});

function normalizeHeaderValue(value: unknown): string | null {
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return String(value[0] ?? '').trim() || null;
  }

  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function authError() {
  return {
    error: {
      type: 'authentication_error',
      message: 'Unauthorized tenant context.'
    }
  };
}

function invalidRequest(message: string, details?: unknown) {
  return {
    error: {
      type: 'invalid_request_error',
      message,
      ...(details ? { details } : {})
    }
  };
}

function permissionError(message: string, delivery?: unknown) {
  return {
    error: {
      type: 'permission_error',
      message
    },
    ...(delivery ? { delivery } : {})
  };
}

function apiError(message: string, delivery?: unknown) {
  return {
    error: {
      type: 'api_error',
      message
    },
    ...(delivery ? { delivery } : {})
  };
}

function rateLimitError(message: string, details?: unknown) {
  return {
    error: {
      type: 'rate_limit_error',
      message,
      ...(details ? { details } : {})
    }
  };
}

async function authorizeSecurityExportOperatorAction(options: {
  tenantId: string;
  req: { ip: string; url: string; requestContext?: { authPrincipalName?: string; requestId?: string } };
  incidentId: string;
  action: SecurityExportOperatorAction;
}) {
  const actor = options.req.requestContext?.authPrincipalName ?? 'unknown';
  const decision = await evaluateSecurityExportOperatorAuthorization({
    tenantId: options.tenantId,
    action: options.action,
    principalName: actor
  });

  if (decision.allowed) {
    return {
      allowed: true as const,
      actor,
      decision,
      authorizationMode: 'operator_policy' as const,
      delegationGrant: null as SecurityExportOperatorDelegation | null
    };
  }

  const delegationGrant = await findActiveSecurityExportOperatorDelegation({
    tenantId: options.tenantId,
    incidentId: options.incidentId,
    action: options.action,
    delegatePrincipal: actor
  });
  if (delegationGrant) {
    return {
      allowed: true as const,
      actor,
      decision,
      authorizationMode: 'delegated_grant' as const,
      delegationGrant
    };
  }

  recordSecurityExportOperatorActionDenied({
    tenantId: options.tenantId,
    req: options.req,
    action: options.action,
    actor,
    incidentId: options.incidentId,
    mode: decision.policy.mode,
    reason: decision.reason
  });

  return {
    allowed: false as const,
    actor,
    decision,
    authorizationMode: 'denied' as const,
    delegationGrant: null as SecurityExportOperatorDelegation | null,
    payload: permissionError(
      `Principal ${actor || 'unknown'} is not authorized to ${options.action.replaceAll('_', ' ')} security export delivery incidents under the current operator policy.`,
      {
        operator_policy: toSecurityExportOperatorPolicyPayload(decision.policy),
        action: options.action,
        actor,
        reason: decision.reason,
        incident_id: options.incidentId
      }
    )
  };
}

async function authorizeSecurityExportOperatorDelegationWrite(options: {
  tenantId: string;
  req: { ip: string; url: string; requestContext?: { authPrincipalName?: string; requestId?: string } };
  incidentId: string;
}) {
  const actor = options.req.requestContext?.authPrincipalName ?? 'unknown';
  const decision = await evaluateSecurityExportOperatorAuthorization({
    tenantId: options.tenantId,
    action: 'clear_approve',
    principalName: actor
  });

  if (decision.allowed) {
    return {
      allowed: true as const,
      actor,
      decision
    };
  }

  recordSecurityExportOperatorActionDenied({
    tenantId: options.tenantId,
    req: options.req,
    action: 'clear_approve',
    actor,
    incidentId: options.incidentId,
    mode: decision.policy.mode,
    reason: decision.reason
  });

  return {
    allowed: false as const,
    actor,
    decision,
    payload: permissionError(
      `Principal ${actor || 'unknown'} is not authorized to manage break-glass operator delegations under the current operator policy.`,
      {
        operator_policy: toSecurityExportOperatorPolicyPayload(decision.policy),
        action: 'clear_approve',
        actor,
        reason: decision.reason,
        incident_id: options.incidentId
      }
    )
  };
}

function evaluateSecurityExportOperatorDelegationStepUp(req: {
  headers: Record<string, unknown>;
  requestContext?: {
    authMode?: 'api_key' | 'ui_session';
    authApiKey?: string;
    authPrincipalName?: string;
  };
}) {
  const maxAgeSeconds = Math.max(0, Math.trunc(config.security.exportOperatorDelegationStepUpMaxAgeSeconds));
  if (maxAgeSeconds <= 0) {
    return {
      allowed: true as const,
      assurance: 'disabled' as const
    };
  }

  if (req.requestContext?.authMode === 'api_key') {
    return {
      allowed: true as const,
      assurance: 'api_key' as const
    };
  }

  const token = req.requestContext?.authApiKey ?? '';
  if (!token) {
    return {
      allowed: false as const,
      statusCode: 401,
      payload: authError()
    };
  }

  const resolution = uiSessionStore.resolve(token, {
    touch: false,
    userAgent: normalizeHeaderValue(req.headers['user-agent']) ?? undefined,
    maxIdleSeconds: config.uiSession.maxIdleSeconds
  });

  if (!resolution.session) {
    return {
      allowed: false as const,
      statusCode: 401,
      payload: authError()
    };
  }

  const sessionAgeSeconds = Math.max(0, Math.floor((Date.now() - resolution.session.createdAt) / 1000));
  if (sessionAgeSeconds <= maxAgeSeconds) {
    return {
      allowed: true as const,
      assurance: 'fresh_ui_session' as const,
      sessionAgeSeconds
    };
  }

  return {
    allowed: false as const,
    statusCode: 403,
    payload: permissionError(
      'Break-glass delegation changes require a fresh UI session re-authentication or direct API key credential.',
      {
        step_up: {
          required: true,
          reason: 'ui_session_too_old',
          actor: req.requestContext?.authPrincipalName ?? 'unknown',
          max_age_seconds: maxAgeSeconds,
          session_age_seconds: sessionAgeSeconds,
          created_at: new Date(resolution.session.createdAt).toISOString()
        }
      }
    )
  };
}

async function consumeSecurityExportOperatorDelegationIfNeeded(options: {
  tenantId: string;
  incidentId: string;
  action: SecurityExportOperatorAction;
  actor: string;
  authorization: {
    authorizationMode: 'operator_policy' | 'delegated_grant' | 'denied';
    delegationGrant: SecurityExportOperatorDelegation | null;
  };
}) {
  if (options.authorization.authorizationMode !== 'delegated_grant' || !options.authorization.delegationGrant) {
    return { ok: true as const, grant: null as SecurityExportOperatorDelegation | null };
  }

  return consumeSecurityExportOperatorDelegation({
    tenantId: options.tenantId,
    grantId: options.authorization.delegationGrant.grant_id,
    incidentId: options.incidentId,
    action: options.action,
    actor: options.actor
  });
}

function getSecurityExportOperatorDelegationScope(grant: SecurityExportOperatorDelegation) {
  const incident = getSecurityExportDeliveryIncident(grant.tenant_id, grant.incident_id);

  if (grant.incident_revision === null) {
    return {
      status: 'legacy_unscoped' as const,
      incident_revision: null,
      current_incident_revision: incident?.revision ?? null,
      incident_status: incident?.status ?? null
    };
  }

  if (!incident) {
    return {
      status: 'incident_missing' as const,
      incident_revision: grant.incident_revision,
      current_incident_revision: null,
      incident_status: null
    };
  }

  if (incident.status !== 'active') {
    return {
      status: 'incident_resolved' as const,
      incident_revision: grant.incident_revision,
      current_incident_revision: incident.revision,
      incident_status: incident.status
    };
  }

  if (incident.revision !== grant.incident_revision) {
    return {
      status: 'revision_stale' as const,
      incident_revision: grant.incident_revision,
      current_incident_revision: incident.revision,
      incident_status: incident.status
    };
  }

  return {
    status: 'current' as const,
    incident_revision: grant.incident_revision,
    current_incident_revision: incident.revision,
    incident_status: incident.status
  };
}

function validateDelegatedSecurityExportOperatorActionScope(options: {
  tenantId: string;
  incidentId: string;
  expectedRevision: number | undefined;
  authorization: {
    authorizationMode: 'operator_policy' | 'delegated_grant' | 'denied';
    delegationGrant: SecurityExportOperatorDelegation | null;
  };
}) {
  if (options.authorization.authorizationMode !== 'delegated_grant' || !options.authorization.delegationGrant) {
    return { ok: true as const };
  }

  const grant = options.authorization.delegationGrant;
  if (grant.incident_revision === null) {
    return {
      ok: false as const,
      statusCode: 409,
      payload: apiError('This break-glass delegation predates incident revision scoping and must be re-requested.', {
        code: 'delegation_scope_legacy_unscoped',
        grant_id: grant.grant_id,
        incident_id: grant.incident_id
      })
    };
  }

  if (options.expectedRevision === undefined) {
    return {
      ok: false as const,
      statusCode: 400,
      payload: invalidRequest('Delegated incident actions require the incident revision.', {
        code: 'delegation_revision_required',
        grant_id: grant.grant_id,
        incident_id: grant.incident_id
      })
    };
  }

  if (options.expectedRevision !== grant.incident_revision) {
    return {
      ok: false as const,
      statusCode: 409,
      payload: apiError('Break-glass delegation is scoped to a different incident revision. Refresh the incident and request a new delegation.', {
        code: 'delegation_incident_revision_conflict',
        grant_id: grant.grant_id,
        incident_id: grant.incident_id,
        delegation_incident_revision: grant.incident_revision,
        requested_incident_revision: options.expectedRevision
      })
    };
  }

  const scope = getSecurityExportOperatorDelegationScope(grant);
  if (scope.status !== 'current') {
    return {
      ok: false as const,
      statusCode: 409,
      payload: apiError('Break-glass delegation scope is stale. Refresh the incident and request a new delegation.', {
        code: 'delegation_scope_stale',
        grant_id: grant.grant_id,
        incident_id: grant.incident_id,
        scope
      })
    };
  }

  return { ok: true as const };
}

function verifyExportBundleForTenant(bundle: SecurityAuditExportBundle, tenantId: string) {
  const integrity = verifySecurityAuditIntegrity({
    events: bundle.data,
    anchorPrevChainHash: bundle.integrity.anchorPrevChainHash ?? null
  });
  const signatureVerification = verifySecurityAuditExportBundleSignature(bundle);
  const verified = integrity.verified && signatureVerification.verified;
  const failureReason = integrity.verified ? signatureVerification.reason : integrity.failureReason;

  return {
    tenantId,
    integrity,
    signatureVerification,
    data: {
      ...integrity,
      verified,
      ...(failureReason ? { failureReason } : {}),
      signature_verified: signatureVerification.verified,
      signature: signatureVerification
    }
  };
}

function toSecurityExportDeliveryPolicyPayload(policy: EffectiveSecurityExportDeliveryPolicy) {
  return {
    object: 'security_export.delivery_policy',
    tenant_id: policy.tenantId,
    source: policy.source,
    policy_status: policy.policyStatus,
    mode: policy.mode,
    allowed_targets: policy.allowedTargets,
    deployment_default_mode: policy.deploymentDefaultMode,
    deployment_default_allowed_targets: policy.deploymentDefaultAllowedTargets,
    updated_at: policy.updatedAt
  };
}

function toSecurityExportOperatorPolicyPayload(policy: EffectiveSecurityExportOperatorPolicy) {
  return {
    object: 'security_export.operator_policy',
    tenant_id: policy.tenantId,
    source: policy.source,
    policy_status: policy.policyStatus,
    mode: policy.mode,
    roster: policy.roster,
    deployment_default_mode: policy.deploymentDefaultMode,
    deployment_default_roster: policy.deploymentDefaultRoster,
    updated_at: policy.updatedAt
  };
}

function toSecurityExportOperatorDelegationPayload(grant: SecurityExportOperatorDelegation) {
  return {
    object: 'security_export.operator_delegation',
    tenant_id: grant.tenant_id,
    grant_id: grant.grant_id,
    incident_id: grant.incident_id,
    incident_revision: grant.incident_revision,
    action: grant.action,
    delegate_principal: grant.delegate_principal,
    requested_by: grant.requested_by,
    requested_at: grant.requested_at,
    requested_ttl_minutes: grant.requested_ttl_minutes,
    approval_expires_at: grant.approval_expires_at,
    issued_by: grant.issued_by,
    issued_at: grant.issued_at,
    approved_by: grant.approved_by,
    approved_at: grant.approved_at,
    approval_note: grant.approval_note,
    expires_at: grant.expires_at,
    justification: grant.justification,
    status: grant.status,
    consumed_at: grant.consumed_at,
    consumed_by: grant.consumed_by,
    revoked_at: grant.revoked_at,
    revoked_by: grant.revoked_by,
    revoke_reason: grant.revoke_reason,
    scope: getSecurityExportOperatorDelegationScope(grant)
  };
}

function recordSecurityExportDeliveryPolicyAudit(params: {
  tenantId: string;
  req: { ip: string; url: string; requestContext?: { requestId?: string } };
  type: 'security_export_delivery_policy_updated' | 'security_export_delivery_policy_reset' | 'security_export_delivery_previewed';
  details?: Record<string, string | number | boolean | null | undefined>;
}) {
  securityAuditLog.record({
    tenant_id: params.tenantId,
    type: params.type,
    ip: params.req.ip,
    request_id: params.req.requestContext?.requestId,
    details: {
      path: params.req.url,
      ...Object.fromEntries(Object.entries(params.details ?? {}).filter(([, value]) => value !== undefined))
    }
  });
}

function recordSecurityExportOperatorPolicyAudit(params: {
  tenantId: string;
  req: { ip: string; url: string; requestContext?: { requestId?: string } };
  type: 'security_export_operator_policy_updated' | 'security_export_operator_policy_reset';
  details?: Record<string, string | number | boolean | null | undefined>;
}) {
  securityAuditLog.record({
    tenant_id: params.tenantId,
    type: params.type,
    ip: params.req.ip,
    request_id: params.req.requestContext?.requestId,
    details: {
      path: params.req.url,
      ...Object.fromEntries(Object.entries(params.details ?? {}).filter(([, value]) => value !== undefined))
    }
  });
}

function recordSecurityExportOperatorActionDenied(params: {
  tenantId: string;
  req: { ip: string; url: string; requestContext?: { requestId?: string } };
  action: SecurityExportOperatorAction;
  actor: string;
  incidentId: string;
  mode: string;
  reason: string;
}) {
  securityAuditLog.record({
    tenant_id: params.tenantId,
    type: 'security_export_operator_action_denied',
    ip: params.req.ip,
    request_id: params.req.requestContext?.requestId,
    details: {
      path: params.req.url,
      action: params.action,
      actor: params.actor,
      incident_id: params.incidentId,
      policy_mode: params.mode,
      reason: params.reason
    }
  });
}

function recordSecurityExportOperatorDelegationAudit(params: {
  tenantId: string;
  req: { ip: string; url: string; requestContext?: { requestId?: string } };
  type:
    | 'security_export_operator_delegation_requested'
    | 'security_export_operator_delegation_issued'
    | 'security_export_operator_delegation_consumed'
    | 'security_export_operator_delegation_revoked';
  grant: SecurityExportOperatorDelegation;
}) {
  securityAuditLog.record({
    tenant_id: params.tenantId,
    type: params.type,
    ip: params.req.ip,
    request_id: params.req.requestContext?.requestId,
    details: {
      path: params.req.url,
      grant_id: params.grant.grant_id,
      incident_id: params.grant.incident_id,
      action: params.grant.action,
      delegate_principal: params.grant.delegate_principal,
      requested_by: params.grant.requested_by,
      requested_at: params.grant.requested_at,
      approval_expires_at: params.grant.approval_expires_at,
      issued_by: params.grant.issued_by,
      issued_at: params.grant.issued_at,
      approved_by: params.grant.approved_by,
      approved_at: params.grant.approved_at,
      expires_at: params.grant.expires_at,
      status: params.grant.status,
      consumed_by: params.grant.consumed_by,
      revoked_by: params.grant.revoked_by
    }
  });
}

function recordSecurityExportSigningAudit(params: {
  tenantId: string;
  req: { ip: string; url: string; requestContext?: { requestId?: string } };
  type: 'security_export_signing_rotated' | 'security_export_signing_policy_updated' | 'security_export_signing_maintenance_run';
  details?: Record<string, string | number | boolean | null | undefined>;
}) {
  securityAuditLog.record({
    tenant_id: params.tenantId,
    type: params.type,
    ip: params.req.ip,
    request_id: params.req.requestContext?.requestId,
    details: {
      path: params.req.url,
      ...Object.fromEntries(Object.entries(params.details ?? {}).filter(([, value]) => value !== undefined))
    }
  });
}

function replyForSecurityExportSigningError(reply: { status: (code: number) => { send: (payload: unknown) => unknown } }, error: unknown) {
  if (!(error instanceof SecurityExportSigningError)) {
    return null;
  }

  return reply.status(error.statusCode).send(
    apiError(error.message, {
      code: error.code,
      lifecycle: securityExportSigningRegistry.getLifecycleState()
    })
  );
}

export async function registerSecurityEventsRoute(app: FastifyInstance) {
  app.get(getSecurityExportJwksPath(), async () => securityExportSigningRegistry.getPublicJwks());

  app.get('/v1/security/events', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = LIST_QUERY_SCHEMA.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send(invalidRequest('Invalid query for security events list.', parsed.error.flatten()));
    }

    const type = parsed.data.type as SecurityAuditEventType | undefined;
    const sinceTimestamp = parsed.data.since ? Date.parse(parsed.data.since) : undefined;
    const data = securityAuditLog.list(tenantId, {
      limit: parsed.data.limit,
      type,
      sinceTimestamp
    });

    return {
      object: 'list',
      data
    };
  });

  app.get('/v1/security/summary', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = SUMMARY_QUERY_SCHEMA.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send(invalidRequest('Invalid query for security summary.', parsed.error.flatten()));
    }

    const sinceTimestamp = Date.now() - parsed.data.window_hours * 60 * 60 * 1000;
    const summary = securityAuditLog.summarize(tenantId, {
      sinceTimestamp,
      topIpLimit: parsed.data.top_ip_limit
    });

    return {
      object: 'security_summary',
      tenant_id: tenantId,
      ...summary,
      signing: securityExportSigningRegistry.getLifecycleState()
    };
  });

  app.get('/v1/security/export/keys', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    try {
      const lifecycle = securityExportSigningRegistry.getLifecycleState();
      return {
        object: 'security_export_signing_keys',
        tenant_id: tenantId,
        jwks_path: getSecurityExportJwksPath(),
        active_key_id: lifecycle.active_key_id,
        policy: lifecycle.policy,
        lifecycle,
        maintenance: securityExportSigningRegistry.getMaintenanceState(),
        data: securityExportSigningRegistry.listKeySummaries()
      };
    } catch (error) {
      const handled = replyForSecurityExportSigningError(reply, error);
      if (handled) {
        return handled;
      }
      throw error;
    }
  });

  app.get('/v1/security/export/signing-policy', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const lifecycle = securityExportSigningRegistry.getLifecycleState();
    return {
      object: 'security_export_signing_policy',
      tenant_id: tenantId,
      jwks_path: getSecurityExportJwksPath(),
      data: lifecycle.policy,
      lifecycle,
      maintenance: securityExportSigningRegistry.getMaintenanceState()
    };
  });

  app.put('/v1/security/export/signing-policy', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = SIGNING_POLICY_BODY_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidRequest('Invalid request body for signing policy.', parsed.error.flatten()));
    }

    try {
      const policy = await securityExportSigningRegistry.updateLifecyclePolicy(parsed.data);
      const lifecycle = securityExportSigningRegistry.getLifecycleState();
      recordSecurityExportSigningAudit({
        tenantId,
        req,
        type: 'security_export_signing_policy_updated',
        details: {
          auto_rotate: policy.auto_rotate,
          rotate_after_hours: policy.rotate_after_hours,
          expire_after_hours: policy.expire_after_hours,
          warn_before_hours: policy.warn_before_hours,
          verify_retention_hours: policy.verify_retention_hours
        }
      });

      return {
        object: 'security_export_signing_policy',
        tenant_id: tenantId,
        jwks_path: getSecurityExportJwksPath(),
        updated: true,
        data: policy,
        lifecycle,
        maintenance: securityExportSigningRegistry.getMaintenanceState()
      };
    } catch (error) {
      const handled = replyForSecurityExportSigningError(reply, error);
      if (handled) {
        return handled;
      }
      throw error;
    }
  });

  app.post('/v1/security/export/keys/rotate', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    try {
      const previousActiveKeyId = securityExportSigningRegistry.getActiveKeySummary().key_id;
      const activeKey = await securityExportSigningRegistry.rotate();
      const lifecycle = securityExportSigningRegistry.getLifecycleState();
      recordSecurityExportSigningAudit({
        tenantId,
        req,
        type: 'security_export_signing_rotated',
        details: {
          previous_active_key_id: previousActiveKeyId,
          active_key_id: activeKey.key_id,
          verify_only_count: lifecycle.verify_only.total
        }
      });

      return {
        object: 'security_export_signing_keys',
        tenant_id: tenantId,
        jwks_path: getSecurityExportJwksPath(),
        active_key_id: activeKey.key_id,
        rotated: true,
        policy: lifecycle.policy,
        lifecycle,
        maintenance: securityExportSigningRegistry.getMaintenanceState(),
        data: securityExportSigningRegistry.listKeySummaries()
      };
    } catch (error) {
      const handled = replyForSecurityExportSigningError(reply, error);
      if (handled) {
        return handled;
      }
      throw error;
    }
  });

  app.get('/v1/security/export/signing-maintenance', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    return {
      object: 'security_export_signing_maintenance',
      tenant_id: tenantId,
      data: securityExportSigningRegistry.getMaintenanceState()
    };
  });

  app.post('/v1/security/export/signing-maintenance/run', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = SIGNING_MAINTENANCE_BODY_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidRequest('Invalid payload for signing maintenance run.', parsed.error.flatten()));
    }

    try {
      const run = securityExportSigningRegistry.runMaintenanceNow({ dryRun: parsed.data.dry_run });
      if (!parsed.data.dry_run) {
        recordSecurityExportSigningAudit({
          tenantId,
          req,
          type: 'security_export_signing_maintenance_run',
          details: {
            changed: run.changed,
            skipped_reason: run.skipped_reason,
            actions: run.actions.join(','),
            rotation_performed: run.rotation_performed,
            pruned_verify_only_keys: run.pruned_verify_only_keys,
            active_key_id_before: run.active_key_id_before,
            active_key_id_after: run.active_key_id_after,
            lease_holder_id: run.lease.holder_id,
            lease_acquired: run.lease.acquired
          }
        });
      }

      return {
        object: 'security_export_signing_maintenance',
        tenant_id: tenantId,
        data: run,
        lifecycle: securityExportSigningRegistry.getLifecycleState(),
        maintenance: securityExportSigningRegistry.getMaintenanceState()
      };
    } catch (error) {
      const handled = replyForSecurityExportSigningError(reply, error);
      if (handled) {
        return handled;
      }
      throw error;
    }
  });

  app.get('/v1/security/export/delivery-policy', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const policy = await getEffectiveSecurityExportDeliveryPolicy(tenantId);
    return toSecurityExportDeliveryPolicyPayload(policy);
  });

  app.put('/v1/security/export/delivery-policy', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = DELIVERY_POLICY_BODY_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidRequest('Invalid payload for security export delivery policy.', parsed.error.flatten()));
    }

    const result = await setTenantSecurityExportDeliveryPolicy(tenantId, parsed.data);
    if (!result.ok) {
      return reply.status(result.statusCode).send(
        invalidRequest(result.reason, {
          code: result.code
        })
      );
    }

    recordSecurityExportDeliveryPolicyAudit({
      tenantId,
      req,
      type: 'security_export_delivery_policy_updated',
      details: {
        mode: result.policy.mode,
        allowed_targets: result.policy.allowedTargets.length
      }
    });

    const policy = await getEffectiveSecurityExportDeliveryPolicy(tenantId);
    return toSecurityExportDeliveryPolicyPayload(policy);
  });

  app.delete('/v1/security/export/delivery-policy', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const reset = await resetTenantSecurityExportDeliveryPolicy(tenantId);
    if (reset) {
      recordSecurityExportDeliveryPolicyAudit({
        tenantId,
        req,
        type: 'security_export_delivery_policy_reset',
        details: {
          reason: 'reset_to_deployment_defaults'
        }
      });
    }

    const policy = await getEffectiveSecurityExportDeliveryPolicy(tenantId);
    return {
      reset,
      ...toSecurityExportDeliveryPolicyPayload(policy)
    };
  });

  app.get('/v1/security/export/operator-policy', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const policy = await getEffectiveSecurityExportOperatorPolicy(tenantId);
    return toSecurityExportOperatorPolicyPayload(policy);
  });

  app.put('/v1/security/export/operator-policy', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = OPERATOR_POLICY_BODY_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidRequest('Invalid payload for security export operator policy.', parsed.error.flatten()));
    }

    const result = await setTenantSecurityExportOperatorPolicy(tenantId, parsed.data);
    if (!result.ok) {
      return reply.status(result.statusCode).send(
        invalidRequest(result.reason, {
          code: result.code
        })
      );
    }

    recordSecurityExportOperatorPolicyAudit({
      tenantId,
      req,
      type: 'security_export_operator_policy_updated',
      details: {
        mode: result.policy.mode,
        acknowledge_count: result.policy.roster.acknowledge.length,
        clear_request_count: result.policy.roster.clear_request.length,
        clear_approve_count: result.policy.roster.clear_approve.length
      }
    });

    const policy = await getEffectiveSecurityExportOperatorPolicy(tenantId);
    return toSecurityExportOperatorPolicyPayload(policy);
  });

  app.delete('/v1/security/export/operator-policy', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const reset = await resetTenantSecurityExportOperatorPolicy(tenantId);
    if (reset) {
      recordSecurityExportOperatorPolicyAudit({
        tenantId,
        req,
        type: 'security_export_operator_policy_reset',
        details: {
          reason: 'reset_to_deployment_defaults'
        }
      });
    }

    const policy = await getEffectiveSecurityExportOperatorPolicy(tenantId);
    return {
      reset,
      ...toSecurityExportOperatorPolicyPayload(policy)
    };
  });

  app.get('/v1/security/export/operator-delegations', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = OPERATOR_DELEGATION_LIST_QUERY_SCHEMA.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send(invalidRequest('Invalid query for security export operator delegations.', parsed.error.flatten()));
    }

    const delegations = await listSecurityExportOperatorDelegations(tenantId, {
      limit: parsed.data.limit,
      status: parsed.data.status as SecurityExportOperatorDelegationStatus | undefined
    });

    return {
      object: 'list',
      tenant_id: tenantId,
      data: delegations.map((grant) => toSecurityExportOperatorDelegationPayload(grant))
    };
  });

  app.post('/v1/security/export/operator-delegations', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = OPERATOR_DELEGATION_BODY_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidRequest('Invalid payload for security export operator delegation.', parsed.error.flatten()));
    }

    const incident = getSecurityExportDeliveryIncident(tenantId, parsed.data.incidentId);
    if (!incident || incident.status !== 'active') {
      return reply.status(404).send(
        invalidRequest('Security export delivery incident not found or no longer active for delegation.', {
          incident_id: parsed.data.incidentId
        })
      );
    }

    const authorization = await authorizeSecurityExportOperatorDelegationWrite({
      tenantId,
      req,
      incidentId: parsed.data.incidentId
    });
    if (!authorization.allowed) {
      return reply.status(403).send(authorization.payload);
    }

    const stepUp = evaluateSecurityExportOperatorDelegationStepUp(req);
    if (!stepUp.allowed) {
      return reply.status(stepUp.statusCode).send(stepUp.payload);
    }

    const result = await createSecurityExportOperatorDelegation({
      tenantId,
      incidentId: parsed.data.incidentId,
      incidentRevision: incident.revision,
      action: parsed.data.action,
      delegatePrincipal: parsed.data.delegatePrincipal,
      actor: authorization.actor,
      justification: parsed.data.justification,
      ttlMinutes: parsed.data.ttlMinutes
    });

    if (!result.ok) {
      const details = {
        code: result.code,
        incident_id: parsed.data.incidentId,
        action: parsed.data.action,
        delegate_principal: parsed.data.delegatePrincipal
      };
      return reply.status(result.statusCode).send(result.statusCode === 400 ? invalidRequest(result.reason, details) : apiError(result.reason, details));
    }

    recordSecurityExportOperatorDelegationAudit({
      tenantId,
      req,
      type: 'security_export_operator_delegation_requested',
      grant: result.grant
    });

    return {
      object: 'security_export.operator_delegation',
      tenant_id: tenantId,
      data: toSecurityExportOperatorDelegationPayload(result.grant)
    };
  });

  app.post('/v1/security/export/operator-delegations/:grantId/approve', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const params = OPERATOR_DELEGATION_PARAMS_SCHEMA.safeParse(req.params ?? {});
    if (!params.success) {
      return reply.status(400).send(invalidRequest('Invalid operator delegation id.', params.error.flatten()));
    }

    const parsed = OPERATOR_DELEGATION_APPROVE_BODY_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidRequest('Invalid payload for operator delegation approval.', parsed.error.flatten()));
    }

    const existing = await getSecurityExportOperatorDelegation(tenantId, params.data.grantId);
    const authorization = await authorizeSecurityExportOperatorDelegationWrite({
      tenantId,
      req,
      incidentId: existing?.incident_id ?? '00000000-0000-4000-8000-000000000000'
    });
    if (!authorization.allowed) {
      return reply.status(403).send(authorization.payload);
    }

    const stepUp = evaluateSecurityExportOperatorDelegationStepUp(req);
    if (!stepUp.allowed) {
      return reply.status(stepUp.statusCode).send(stepUp.payload);
    }

    if (!existing) {
      return reply.status(404).send(apiError('Operator delegation not found.', { code: 'delegation_not_found', grant_id: params.data.grantId }));
    }

    const incident = getSecurityExportDeliveryIncident(tenantId, existing.incident_id);
    if (!incident || incident.status !== 'active') {
      return reply.status(409).send(
        apiError('Security export delivery incident is no longer active for delegation approval.', {
          code: 'incident_inactive',
          incident_id: existing.incident_id,
          grant_id: params.data.grantId
        })
      );
    }

    const scope = getSecurityExportOperatorDelegationScope(existing);
    if (scope.status !== 'current') {
      return reply.status(409).send(
        apiError('Break-glass delegation approval scope is stale. Refresh the incident and request a new delegation.', {
          code: 'delegation_scope_stale',
          grant_id: params.data.grantId,
          incident_id: existing.incident_id,
          scope
        })
      );
    }

    const result = await approveSecurityExportOperatorDelegation({
      tenantId,
      grantId: params.data.grantId,
      actor: authorization.actor,
      note: parsed.data.note
    });
    if (!result.ok) {
      return reply.status(result.statusCode).send(apiError(result.reason, { code: result.code, grant_id: params.data.grantId }));
    }

    recordSecurityExportOperatorDelegationAudit({
      tenantId,
      req,
      type: 'security_export_operator_delegation_issued',
      grant: result.grant
    });

    return {
      object: 'security_export.operator_delegation',
      tenant_id: tenantId,
      data: toSecurityExportOperatorDelegationPayload(result.grant)
    };
  });

  app.post('/v1/security/export/operator-delegations/:grantId/revoke', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const params = OPERATOR_DELEGATION_PARAMS_SCHEMA.safeParse(req.params ?? {});
    if (!params.success) {
      return reply.status(400).send(invalidRequest('Invalid operator delegation id.', params.error.flatten()));
    }

    const parsed = OPERATOR_DELEGATION_REVOKE_BODY_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidRequest('Invalid payload for operator delegation revoke.', parsed.error.flatten()));
    }

    const existing = await getSecurityExportOperatorDelegation(tenantId, params.data.grantId);
    const authorization = await authorizeSecurityExportOperatorDelegationWrite({
      tenantId,
      req,
      incidentId: existing?.incident_id ?? '00000000-0000-4000-8000-000000000000'
    });
    if (!authorization.allowed) {
      return reply.status(403).send(authorization.payload);
    }

    const stepUp = evaluateSecurityExportOperatorDelegationStepUp(req);
    if (!stepUp.allowed) {
      return reply.status(stepUp.statusCode).send(stepUp.payload);
    }

    const result = await revokeSecurityExportOperatorDelegation({
      tenantId,
      grantId: params.data.grantId,
      actor: authorization.actor,
      reason: parsed.data.reason
    });
    if (!result.ok) {
      return reply.status(result.statusCode).send(apiError(result.reason, { code: result.code, grant_id: params.data.grantId }));
    }

    recordSecurityExportOperatorDelegationAudit({
      tenantId,
      req,
      type: 'security_export_operator_delegation_revoked',
      grant: result.grant
    });

    return {
      object: 'security_export.operator_delegation',
      tenant_id: tenantId,
      data: toSecurityExportOperatorDelegationPayload(result.grant)
    };
  });

  app.get('/v1/security/export', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = EXPORT_QUERY_SCHEMA.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send(invalidRequest('Invalid query for security export.', parsed.error.flatten()));
    }

    try {
      const exportBundle = ensureSignedSecurityAuditExportBundle(
        securityAuditLog.export(tenantId, {
          sinceTimestamp: parsed.data.since ? Date.parse(parsed.data.since) : undefined,
          limit: parsed.data.limit,
          topIpLimit: parsed.data.top_ip_limit
        })
      );

      return exportBundle;
    } catch (error) {
      const handled = replyForSecurityExportSigningError(reply, error);
      if (handled) {
        return handled;
      }
      throw error;
    }
  });

  app.post('/v1/security/export/deliveries/preview', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = DELIVERY_PREVIEW_BODY_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidRequest('Invalid payload for security export delivery preview.', parsed.error.flatten()));
    }

    try {
      const preview = await previewSecurityExportDeliveryTarget({
        tenantId,
        destinationUrl: parsed.data.destinationUrl
      });

      recordSecurityExportDeliveryPolicyAudit({
        tenantId,
        req,
        type: 'security_export_delivery_previewed',
        details: {
          allowed: preview.allowed,
          mode: preview.policy.mode,
          host: preview.destination.host,
          path_hash: preview.destination.path_hash,
          matched_rule: preview.matched_rule,
          pinned_address_family: preview.pinned_address_family,
          reason: preview.reason,
          health_verdict: preview.health.verdict,
          quarantined_until: preview.health.quarantined_until
        }
      });

      return {
        object: 'security_export_delivery_preview',
        tenant_id: tenantId,
        allowed: preview.allowed,
        reason: preview.reason,
        matched_rule: preview.matched_rule,
        destination: preview.destination,
        pinned_address: preview.pinned_address,
        pinned_address_family: preview.pinned_address_family,
        health: preview.health,
        policy: toSecurityExportDeliveryPolicyPayload(preview.policy)
      };
    } catch (error) {
      return reply.status(400).send(invalidRequest(error instanceof Error ? error.message : String(error)));
    }
  });

  app.get('/v1/security/export/deliveries', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = DELIVERY_LIST_QUERY_SCHEMA.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send(invalidRequest('Invalid query for security export deliveries.', parsed.error.flatten()));
    }

    return {
      object: 'list',
      data: listSecurityExportDeliveries(tenantId, {
        limit: parsed.data.limit,
        status: parsed.data.status
      })
    };
  });

  app.get('/v1/security/export/delivery-analytics', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = DELIVERY_ANALYTICS_QUERY_SCHEMA.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send(invalidRequest('Invalid query for security export delivery analytics.', parsed.error.flatten()));
    }

    return {
      object: 'security_export_delivery_analytics',
      tenant_id: tenantId,
      data: getSecurityExportDeliveryAnalytics(tenantId, {
        windowHours: parsed.data.window_hours,
        bucketHours: parsed.data.bucket_hours,
        destinationLimit: parsed.data.destination_limit
      })
    };
  });

  app.get('/v1/security/export/delivery-incidents', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = DELIVERY_INCIDENT_LIST_QUERY_SCHEMA.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send(invalidRequest('Invalid query for security export delivery incidents.', parsed.error.flatten()));
    }

    return {
      object: 'list',
      tenant_id: tenantId,
      data: listSecurityExportDeliveryIncidents(tenantId, {
        limit: parsed.data.limit,
        status: parsed.data.status
      })
    };
  });

  app.post('/v1/security/export/deliveries', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = DELIVERY_BODY_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidRequest('Invalid payload for security export delivery.', parsed.error.flatten()));
    }

    const idempotencyKey = normalizeHeaderValue(req.headers['idempotency-key']);
    if (idempotencyKey) {
      if (
        idempotencyKey.length > config.security.exportDeliveryIdempotencyKeyMaxLength ||
        !IDEMPOTENCY_KEY_ALLOWED.test(idempotencyKey)
      ) {
        return reply.status(400).send(invalidRequest('Invalid Idempotency-Key header.'));
      }
    }

    const sinceTimestamp = parsed.data.since
      ? Date.parse(parsed.data.since)
      : Date.now() - parsed.data.windowHours * 60 * 60 * 1000;

    try {
      const bundle = ensureSignedSecurityAuditExportBundle(
        securityAuditLog.export(tenantId, {
          sinceTimestamp,
          limit: parsed.data.limit,
          topIpLimit: parsed.data.topIpLimit
        })
      );

      if (parsed.data.mode === 'async') {
        const queued = await enqueueSecurityAuditExportDelivery({
          tenantId,
          requestId: req.requestContext?.requestId,
          destinationUrl: parsed.data.destinationUrl,
          bundle,
          idempotencyKey: idempotencyKey ?? undefined
        });

        if (!queued.ok) {
          if (queued.reason === 'idempotency_conflict') {
            return reply.status(409).send(invalidRequest('Idempotency-Key is already used with a different request payload.'));
          }

          return reply.status(429).send(
            rateLimitError('Too many active security export deliveries for this tenant. Please retry later.', {
              active_deliveries: queued.activeDeliveries
            })
          );
        }

        return reply.status(queued.reused ? 200 : 202).send({
          object: 'security_export_delivery',
          tenant_id: tenantId,
          data: queued.record,
          queued: true,
          idempotencyReused: queued.reused
        });
      }

      const delivery = await deliverSecurityAuditExport({
        tenantId,
        requestId: req.requestContext?.requestId,
        destinationUrl: parsed.data.destinationUrl,
        bundle
      });

      return {
        object: 'security_export_delivery',
        tenant_id: tenantId,
        data: delivery
      };
    } catch (error) {
      if (error instanceof SecurityExportDeliveryError) {
        if (error.statusCode === 403) {
          return reply.status(403).send(permissionError(error.message, error.record));
        }

        if (error.statusCode === 400) {
          return reply.status(400).send(invalidRequest(error.message, { delivery: error.record }));
        }

        return reply.status(error.statusCode).send(apiError(error.message, error.record));
      }

      const handled = replyForSecurityExportSigningError(reply, error);
      if (handled) {
        return handled;
      }

      throw error;
    }
  });

  app.post('/v1/security/export/delivery-incidents/:incidentId/acknowledge', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const params = DELIVERY_INCIDENT_PARAMS_SCHEMA.safeParse(req.params ?? {});
    if (!params.success) {
      return reply.status(400).send(invalidRequest('Invalid delivery incident id.', params.error.flatten()));
    }

    const parsed = DELIVERY_INCIDENT_ACTION_BODY_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidRequest('Invalid payload for delivery incident acknowledgement.', parsed.error.flatten()));
    }

    const authorization = await authorizeSecurityExportOperatorAction({
      tenantId,
      req,
      incidentId: params.data.incidentId,
      action: 'acknowledge'
    });
    if (!authorization.allowed) {
      return reply.status(403).send(authorization.payload);
    }

    const scopeValidation = validateDelegatedSecurityExportOperatorActionScope({
      tenantId,
      incidentId: params.data.incidentId,
      expectedRevision: parsed.data.revision,
      authorization
    });
    if (!scopeValidation.ok) {
      return reply.status(scopeValidation.statusCode).send(scopeValidation.payload);
    }

    try {
      const incident = await acknowledgeSecurityExportDeliveryIncident({
        tenantId,
        incidentId: params.data.incidentId,
        actor: authorization.actor,
        note: parsed.data.note,
        expectedRevision: parsed.data.revision
      });

      const consumed = await consumeSecurityExportOperatorDelegationIfNeeded({
        tenantId,
        incidentId: params.data.incidentId,
        action: 'acknowledge',
        actor: authorization.actor,
        authorization
      });
      if (!consumed.ok) {
        return reply.status(consumed.statusCode).send(apiError(consumed.reason, { code: consumed.code, incident }));
      }
      if (consumed.grant) {
        recordSecurityExportOperatorDelegationAudit({
          tenantId,
          req,
          type: 'security_export_operator_delegation_consumed',
          grant: consumed.grant
        });
      }

      return {
        object: 'security_export_delivery_incident',
        tenant_id: tenantId,
        data: incident
      };
    } catch (error) {
      if (error instanceof SecurityExportDeliveryIncidentError) {
        if (error.statusCode === 404) {
          return reply.status(404).send(invalidRequest(error.message, { incident: error.incident }));
        }

        if (error.statusCode === 409) {
          return reply.status(409).send(apiError(error.message, error.incident));
        }

        return reply.status(error.statusCode).send(apiError(error.message, error.incident));
      }

      throw error;
    }
  });

  app.post('/v1/security/export/delivery-incidents/:incidentId/clear-request', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const params = DELIVERY_INCIDENT_PARAMS_SCHEMA.safeParse(req.params ?? {});
    if (!params.success) {
      return reply.status(400).send(invalidRequest('Invalid delivery incident id.', params.error.flatten()));
    }

    const parsed = DELIVERY_INCIDENT_ACTION_BODY_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidRequest('Invalid payload for delivery incident clear request.', parsed.error.flatten()));
    }

    const authorization = await authorizeSecurityExportOperatorAction({
      tenantId,
      req,
      incidentId: params.data.incidentId,
      action: 'clear_request'
    });
    if (!authorization.allowed) {
      return reply.status(403).send(authorization.payload);
    }

    const scopeValidation = validateDelegatedSecurityExportOperatorActionScope({
      tenantId,
      incidentId: params.data.incidentId,
      expectedRevision: parsed.data.revision,
      authorization
    });
    if (!scopeValidation.ok) {
      return reply.status(scopeValidation.statusCode).send(scopeValidation.payload);
    }

    try {
      const incident = await requestSecurityExportDeliveryIncidentClear({
        tenantId,
        incidentId: params.data.incidentId,
        actor: authorization.actor,
        note: parsed.data.note,
        expectedRevision: parsed.data.revision,
        requestId: req.requestContext?.requestId
      });

      const consumed = await consumeSecurityExportOperatorDelegationIfNeeded({
        tenantId,
        incidentId: params.data.incidentId,
        action: 'clear_request',
        actor: authorization.actor,
        authorization
      });
      if (!consumed.ok) {
        return reply.status(consumed.statusCode).send(apiError(consumed.reason, { code: consumed.code, incident }));
      }
      if (consumed.grant) {
        recordSecurityExportOperatorDelegationAudit({
          tenantId,
          req,
          type: 'security_export_operator_delegation_consumed',
          grant: consumed.grant
        });
      }

      return {
        object: 'security_export_delivery_incident',
        tenant_id: tenantId,
        data: incident
      };
    } catch (error) {
      if (error instanceof SecurityExportDeliveryIncidentError) {
        if (error.statusCode === 404) {
          return reply.status(404).send(invalidRequest(error.message, { incident: error.incident }));
        }

        if (error.statusCode === 400) {
          return reply.status(400).send(invalidRequest(error.message, { incident: error.incident }));
        }

        if (error.statusCode === 409) {
          return reply.status(409).send(apiError(error.message, error.incident));
        }

        return reply.status(error.statusCode).send(apiError(error.message, error.incident));
      }

      const handled = replyForSecurityExportSigningError(reply, error);
      if (handled) {
        return handled;
      }

      throw error;
    }
  });

  app.post('/v1/security/export/delivery-incidents/:incidentId/clear', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const params = DELIVERY_INCIDENT_PARAMS_SCHEMA.safeParse(req.params ?? {});
    if (!params.success) {
      return reply.status(400).send(invalidRequest('Invalid delivery incident id.', params.error.flatten()));
    }

    const parsed = DELIVERY_INCIDENT_ACTION_BODY_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidRequest('Invalid payload for delivery incident clear.', parsed.error.flatten()));
    }

    const authorization = await authorizeSecurityExportOperatorAction({
      tenantId,
      req,
      incidentId: params.data.incidentId,
      action: 'clear_approve'
    });
    if (!authorization.allowed) {
      return reply.status(403).send(authorization.payload);
    }

    const scopeValidation = validateDelegatedSecurityExportOperatorActionScope({
      tenantId,
      incidentId: params.data.incidentId,
      expectedRevision: parsed.data.revision,
      authorization
    });
    if (!scopeValidation.ok) {
      return reply.status(scopeValidation.statusCode).send(scopeValidation.payload);
    }

    try {
      const incident = await clearSecurityExportDeliveryIncident({
        tenantId,
        incidentId: params.data.incidentId,
        actor: authorization.actor,
        note: parsed.data.note,
        expectedRevision: parsed.data.revision
      });

      const consumed = await consumeSecurityExportOperatorDelegationIfNeeded({
        tenantId,
        incidentId: params.data.incidentId,
        action: 'clear_approve',
        actor: authorization.actor,
        authorization
      });
      if (!consumed.ok) {
        return reply.status(consumed.statusCode).send(apiError(consumed.reason, { code: consumed.code, incident }));
      }
      if (consumed.grant) {
        recordSecurityExportOperatorDelegationAudit({
          tenantId,
          req,
          type: 'security_export_operator_delegation_consumed',
          grant: consumed.grant
        });
      }

      return {
        object: 'security_export_delivery_incident',
        tenant_id: tenantId,
        data: incident
      };
    } catch (error) {
      if (error instanceof SecurityExportDeliveryIncidentError) {
        if (error.statusCode === 404) {
          return reply.status(404).send(invalidRequest(error.message, { incident: error.incident }));
        }

        if (error.statusCode === 409) {
          return reply.status(409).send(apiError(error.message, error.incident));
        }

        return reply.status(error.statusCode).send(apiError(error.message, error.incident));
      }

      throw error;
    }
  });

  app.post('/v1/security/export/deliveries/:deliveryId/redrive', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const parsed = DELIVERY_REDIVE_PARAMS_SCHEMA.safeParse(req.params ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidRequest('Invalid delivery id for security export redrive.', parsed.error.flatten()));
    }

    try {
      const result = await redriveSecurityAuditExportDelivery({
        tenantId,
        requestId: req.requestContext?.requestId,
        deliveryId: parsed.data.deliveryId
      });

      if (!result.ok) {
        return reply.status(429).send(
          rateLimitError('Too many active security export deliveries for this tenant. Please retry later.', {
            active_deliveries: result.activeDeliveries
          })
        );
      }

      return reply.status(202).send({
        object: 'security_export_delivery',
        tenant_id: tenantId,
        data: result.record,
        queued: true,
        redriven: true
      });
    } catch (error) {
      if (error instanceof SecurityExportDeliveryError) {
        if (error.statusCode === 403) {
          return reply.status(403).send(permissionError(error.message, error.record));
        }

        if (error.statusCode === 404) {
          return reply.status(404).send(invalidRequest(error.message, { delivery: error.record }));
        }

        if (error.statusCode === 409) {
          return reply.status(409).send(apiError(error.message, error.record));
        }

        if (error.statusCode === 429) {
          return reply.status(429).send(rateLimitError(error.message, { delivery: error.record }));
        }

        if (error.statusCode === 400) {
          return reply.status(400).send(invalidRequest(error.message, { delivery: error.record }));
        }

        return reply.status(error.statusCode).send(apiError(error.message, error.record));
      }

      const handled = replyForSecurityExportSigningError(reply, error);
      if (handled) {
        return handled;
      }

      throw error;
    }
  });

  app.post('/v1/security/export/verify', async (req, reply) => {
    const tenantId = req.requestContext?.tenantId;
    if (!tenantId) {
      return reply.status(401).send(authError());
    }

    const bundleParsed = VERIFY_BUNDLE_SCHEMA.safeParse(req.body ?? {});
    if (bundleParsed.success) {
      if (bundleParsed.data.tenant_id !== tenantId) {
        return reply.status(400).send(invalidRequest('Export bundle tenant_id must match the authenticated tenant.'));
      }

      const verification = verifyExportBundleForTenant(bundleParsed.data as SecurityAuditExportBundle, tenantId);
      return {
        object: 'security_audit_verification',
        tenant_id: tenantId,
        data: verification.data
      };
    }

    const parsed = VERIFY_BODY_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(invalidRequest('Invalid payload for security export verification.', parsed.error.flatten()));
    }

    const tenantMismatch = parsed.data.events.some((event) => event.tenant_id !== tenantId);
    if (tenantMismatch) {
      return reply.status(400).send(invalidRequest('All exported events must belong to the authenticated tenant.'));
    }

    const integrity = verifySecurityAuditIntegrity({
      events: parsed.data.events,
      anchorPrevChainHash: parsed.data.anchorPrevChainHash ?? null
    });

    return {
      object: 'security_audit_verification',
      tenant_id: tenantId,
      data: {
        ...integrity,
        signature_verified: true,
        signature: null
      }
    };
  });
}
