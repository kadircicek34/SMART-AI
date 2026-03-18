import crypto from 'node:crypto';
import { config } from '../config.js';

export type SecurityAuditEventType =
  | 'ui_session_issued'
  | 'ui_session_revoked'
  | 'ui_auth_failed'
  | 'ui_auth_rate_limited'
  | 'ui_origin_blocked'
  | 'api_auth_failed'
  | 'api_tenant_mismatch'
  | 'api_tenant_invalid'
  | 'api_rate_limited';

export type SecurityAuditEvent = {
  event_id: string;
  tenant_id: string;
  type: SecurityAuditEventType;
  timestamp: string;
  ip?: string;
  request_id?: string;
  details?: Record<string, string | number | boolean | null>;
};

type SecurityAuditListQuery = {
  limit?: number;
  type?: SecurityAuditEventType;
  sinceTimestamp?: number;
};

class SecurityAuditLog {
  private readonly eventsByTenant = new Map<string, SecurityAuditEvent[]>();

  constructor(private readonly maxEventsPerTenant: number) {}

  record(event: Omit<SecurityAuditEvent, 'event_id' | 'timestamp'>): SecurityAuditEvent {
    const now = Date.now();

    const normalized: SecurityAuditEvent = {
      ...event,
      event_id: crypto.randomUUID(),
      timestamp: new Date(now).toISOString()
    };

    const bucket = this.eventsByTenant.get(event.tenant_id) ?? [];
    bucket.push(normalized);

    const overflow = bucket.length - this.maxEventsPerTenant;
    if (overflow > 0) {
      bucket.splice(0, overflow);
    }

    this.eventsByTenant.set(event.tenant_id, bucket);
    return normalized;
  }

  list(tenantId: string, query: SecurityAuditListQuery = {}): SecurityAuditEvent[] {
    const bucket = this.eventsByTenant.get(tenantId) ?? [];

    const filtered = bucket.filter((event) => {
      if (query.type && event.type !== query.type) return false;
      if (query.sinceTimestamp && Date.parse(event.timestamp) <= query.sinceTimestamp) return false;
      return true;
    });

    const limit = Math.max(1, Math.min(query.limit ?? 50, 200));

    return filtered.slice(-limit).reverse();
  }
}

export function createSecurityAuditLog(maxEventsPerTenant = 300): SecurityAuditLog {
  return new SecurityAuditLog(Math.max(1, maxEventsPerTenant));
}

export const securityAuditLog = createSecurityAuditLog(config.security.auditMaxEventsPerTenant);
