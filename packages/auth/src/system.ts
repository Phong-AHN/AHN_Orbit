import { newCorrelationId, type TenantContext } from '@orbit/core';
import type { Permission } from '@orbit/rbac';

/**
 * Contexts for background work (docs/RBAC.md §6).
 *
 * A worker is never "root". It is constructed with an explicit, minimal
 * capability list, so a publish job cannot delete a brand even if a payload
 * asks it to.
 *
 * The `organizationId` handed in here must be **derived from the job's subject
 * row**, never read from its payload (decision D-021). `resolveTenantForJob` in
 * `apps/worker/src/context.ts` is the sanctioned way to obtain it: it looks the
 * subject up by primary key, takes the tenant from that row, and treats the
 * payload's value as a checked assertion whose mismatch is a security event.
 * The tenant-scoped client and RLS then bind every query to whatever is passed.
 */

/** Everything the publish worker is allowed to do, and nothing else. */
export const PUBLISH_WORKER_CAPABILITIES = [
  'post:read',
  'social_account:read',
  'media:read',
] as const satisfies readonly Permission[];

/**
 * The health worker reads an account and records a verdict about it. It
 * deliberately does **not** hold `social_account:reconnect` — reconnecting means
 * putting a human through OAuth, which no background job can do (T1.7).
 */
export const HEALTH_WORKER_CAPABILITIES = [
  'social_account:read',
] as const satisfies readonly Permission[];

export const ANALYTICS_WORKER_CAPABILITIES = [
  'post:read',
  'social_account:read',
] as const satisfies readonly Permission[];

/**
 * The notification worker reads a subject to describe it and resolves who may
 * see it. It holds no permission to *change* anything — a fan-out that could
 * mutate a post would be a strange kind of fan-out (T1.15).
 */
export const NOTIFICATION_WORKER_CAPABILITIES = [
  'post:read',
  'social_account:read',
] as const satisfies readonly Permission[];

export function systemContext(input: {
  organizationId: string;
  actorName: string;
  capabilities: readonly Permission[];
  correlationId?: string;
}): TenantContext {
  return {
    organizationId: input.organizationId,
    principal: {
      kind: 'SYSTEM',
      actorName: input.actorName,
      capabilities: input.capabilities,
    },
    correlationId: input.correlationId ?? newCorrelationId(),
  };
}
