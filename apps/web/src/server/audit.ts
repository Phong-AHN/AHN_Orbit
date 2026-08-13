import { actorUserId, isUserPrincipal, type TenantContext } from '@orbit/core';
import { redact } from '@orbit/observability';
import type { TenantDb } from '@orbit/db';

/**
 * Audit trail (SRS §16, §31).
 *
 * Written inside the same transaction as the change it records, so the log
 * cannot drift from what actually happened. The table is append-only at the
 * grant level — the application role holds no UPDATE or DELETE on it.
 *
 * Reads are never audited; every write that crosses a permission boundary is.
 */

export interface AuditInput {
  action: string;
  resourceType: string;
  resourceId?: string | undefined;
  workspaceId?: string | undefined;
  brandId?: string | undefined;
  before?: unknown;
  after?: unknown;
  /** Required for actions taken on someone else's behalf (docs/RBAC.md note 5). */
  reason?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * Record an audited action. Must be called with the same `db` handle as the
 * mutation, so a rollback discards both together.
 */
export async function audit(db: TenantDb, ctx: TenantContext, input: AuditInput): Promise<void> {
  await db.auditLog.create({
    data: {
      // Passed explicitly because the generated types require it. The scoped
      // client does not *trust* it — applyTenantScope throws if it disagrees
      // with the request's tenant — so stating it is a checked assertion
      // rather than an opportunity to get it wrong.
      organizationId: ctx.organizationId,
      actorUserId: actorUserId(ctx),
      actorType: isUserPrincipal(ctx.principal) ? 'USER' : 'WORKER',
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      workspaceId: input.workspaceId ?? null,
      brandId: input.brandId ?? null,
      // Snapshots pass through the same redaction as logs, so a token or key
      // that lands in a changed field never becomes durable history.
      before: input.before === undefined ? undefined : redactJson(input.before),
      after: input.after === undefined ? undefined : redactJson(input.after),
      reason: input.reason ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      correlationId: ctx.correlationId,
    },
  });
}

function redactJson(value: unknown) {
  return JSON.parse(JSON.stringify(redact(value))) as object;
}

/** Client hints for the audit row, taken from the request. */
export function requestFingerprint(request: Request): Pick<AuditInput, 'ip' | 'userAgent'> {
  const forwarded = request.headers.get('x-forwarded-for');
  return {
    ip: forwarded?.split(',')[0]?.trim() ?? undefined,
    userAgent: request.headers.get('user-agent') ?? undefined,
  };
}
