import { InternalError, ValidationError, isUuid } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { logger, redact } from '@orbit/observability';
import type { AuthenticatedUser } from '@orbit/auth';

/**
 * Recording what a platform administrator did to a tenant (SRS §28, §16;
 * docs/RBAC.md §1 rule 4; T1.18 DoD).
 *
 * The rule this exists to satisfy: *any* admin action against tenant data is
 * audited with an actor **and a reason**. Not optional, not defaulted, not
 * inferred — a support engineer touching a customer's data six months ago has
 * to have left behind a sentence explaining why.
 *
 * ## Why this writes unscoped, and why that is not a hole
 *
 * A platform admin has no membership in the organization they are acting on, so
 * `resolveTenantContext` would refuse them and there is no scoped client to
 * write through. Manufacturing one would mean granting tenant access to do the
 * audit — exactly backwards.
 *
 * So this uses `platformDb` and writes one row into the affected organization's
 * own audit log. Three things keep it narrow:
 *
 *  • it can only ever **append to `AuditLog`** — no other table is reachable
 *    from here, and the application role holds no UPDATE or DELETE on it;
 *  • the `organizationId` is the one being acted on, so the row lands where the
 *    tenant's own admins will see it. The agency can see what we did to them;
 *  • the reason is mandatory and validated before anything is written.
 *
 * It also emits a `securityEvent` log line, because a cross-tenant write by
 * someone with no membership is exactly the shape of thing that should be
 * visible in the security log whether or not it was legitimate.
 */

export interface PlatformAuditInput {
  /** The tenant being acted upon. */
  organizationId: string;
  action: string;
  resourceType: string;
  /**
   * Must be a UUID — `AuditLog.resourceId` is `@db.Uuid`.
   *
   * Not every admin subject has one: a dead-letter id is
   * `{queue}:{jobId}:{timestamp}`, which is a Redis key rather than a row.
   * Such identifiers go in `before`/`after` instead, and passing one here is a
   * programming error caught below rather than a confusing Postgres cast
   * failure at the end of a request.
   */
  resourceId?: string | undefined;
  /** Mandatory. A support action with no stated reason is not an auditable one. */
  reason: string;
  before?: unknown;
  after?: unknown;
  ip?: string | undefined;
  userAgent?: string | undefined;
  correlationId?: string | undefined;
}

/** Long enough to be a sentence, short enough not to be a paste of a log file. */
const MIN_REASON = 8;
const MAX_REASON = 1_000;

export function assertReason(reason: string | undefined): string {
  const trimmed = reason?.trim() ?? '';

  if (trimmed.length < MIN_REASON) {
    throw new ValidationError('An admin action requires a reason', {
      userMessage:
        'Say why you are doing this — a ticket reference or a sentence. It is kept on the customer’s audit trail.',
      details: [{ field: 'reason', issue: `at least ${MIN_REASON} characters` }],
    });
  }

  if (trimmed.length > MAX_REASON) {
    throw new ValidationError('Reason is too long', {
      userMessage: 'Keep the reason to a sentence or two.',
      details: [{ field: 'reason', issue: `at most ${MAX_REASON} characters` }],
    });
  }

  return trimmed;
}

export async function platformAudit(
  admin: AuthenticatedUser,
  input: PlatformAuditInput,
): Promise<void> {
  const reason = assertReason(input.reason);

  if (input.resourceId !== undefined && !isUuid(input.resourceId)) {
    throw new InternalError('Audit resourceId must be a UUID', {
      context: { resourceType: input.resourceType, action: input.action },
    });
  }

  await platformDb.auditLog.create({
    data: {
      organizationId: input.organizationId,
      // The person, not "the platform". An action nobody's name is on is one
      // nobody can be asked about.
      actorUserId: admin.id,
      actorType: 'USER',
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      before: input.before === undefined ? undefined : redactJson(input.before),
      after: input.after === undefined ? undefined : redactJson(input.after),
      reason,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      correlationId: input.correlationId ?? null,
    },
  });

  logger.warn('platform admin acted on tenant data', {
    securityEvent: true,
    action: input.action,
    organizationId: input.organizationId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    adminUserId: admin.id,
    // The reason is on the audit row; repeating it in the log keeps the two
    // readable together when someone is reconstructing an incident.
    reason,
  });
}

function redactJson(value: unknown) {
  return JSON.parse(JSON.stringify(redact(value))) as object;
}
