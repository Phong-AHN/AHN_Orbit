import type { AuthenticatedUser } from '@orbit/auth';
import { ConflictError, NotFoundError, ValidationError, clock, isUuid } from '@orbit/core';
import { platformDb, type Prisma } from '@orbit/db';
import { assertReason, platformAudit } from '@/server/platform-audit';
import { findPlan, planName, readPlanLimits } from '@/features/billing/plans';
import type { PlanDecisionInput } from '@/features/billing/contracts';

/**
 * Answering plan change requests (D-116): the one place a plan is applied.
 *
 * Plans change by hand for now. An organization's Owner asks on its plan page,
 * AHN arranges payment, and a platform administrator approves here, which
 * writes the plan's limits from the catalogue to that organization's
 * `Subscription`. The administrator cannot name a plan or a limit: approving
 * applies exactly what the organization asked for.
 *
 * Reads are unscoped by necessity, as everywhere on the admin surface, and are
 * column allowlists: organization name and slug, plan and limits, who asked
 * and when, and the note they left for AHN. Nothing here reaches client
 * content.
 */

const MAX_ROWS = 100;

const REQUEST_SELECT = {
  id: true,
  plan: true,
  fromPlan: true,
  status: true,
  note: true,
  createdAt: true,
  decidedAt: true,
  decisionReason: true,
  organization: {
    select: {
      id: true,
      name: true,
      slug: true,
      subscription: { select: { plan: true, status: true, limits: true } },
    },
  },
  requestedBy: { select: { name: true, email: true } },
  decidedBy: { select: { name: true, email: true } },
} as const satisfies Prisma.PlanRequestSelect;

type RequestRow = Prisma.PlanRequestGetPayload<{ select: typeof REQUEST_SELECT }>;

function present(row: RequestRow) {
  const subscription = row.organization.subscription;
  return {
    id: row.id,
    status: row.status,
    plan: row.plan,
    planName: planName(row.plan),
    fromPlanName: planName(row.fromPlan),
    note: row.note,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    decisionReason: row.decisionReason,
    organization: {
      id: row.organization.id,
      name: row.organization.name,
      slug: row.organization.slug,
    },
    current: subscription
      ? {
          planName: planName(subscription.plan),
          status: subscription.status,
          limits: readPlanLimits(subscription.limits),
        }
      : null,
    requested: findPlan(row.plan)?.limits ?? null,
    requestedBy: row.requestedBy,
    decidedBy: row.decidedBy,
  };
}

export type AdminPlanRequest = ReturnType<typeof present>;

/** Requests waiting, oldest first, and the latest answers. */
export async function listPlanRequests(): Promise<{
  pending: AdminPlanRequest[];
  recent: AdminPlanRequest[];
}> {
  const [pending, recent] = await Promise.all([
    platformDb.planRequest.findMany({
      where: { status: 'PENDING', organization: { deletedAt: null } },
      select: REQUEST_SELECT,
      orderBy: { createdAt: 'asc' },
      take: MAX_ROWS,
    }),
    platformDb.planRequest.findMany({
      where: { status: { not: 'PENDING' } },
      select: REQUEST_SELECT,
      orderBy: { decidedAt: 'desc' },
      take: 20,
    }),
  ]);

  return { pending: pending.map(present), recent: recent.map(present) };
}

/** For the badge on the admin navigation. */
export async function countPendingPlanRequests(): Promise<number> {
  return platformDb.planRequest.count({
    where: { status: 'PENDING', organization: { deletedAt: null } },
  });
}

export interface DecisionMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
  correlationId?: string | undefined;
}

/**
 * Approve or decline a waiting request.
 *
 * One transaction: the request is claimed (conditionally on still being
 * PENDING, so two administrators cannot both answer it), the plan is applied
 * when approved, and the audit row is written into the organization's own log.
 * The transaction names the organization for row security, so the writes land
 * under the same policy a tenant's own writes do.
 */
export async function decidePlanRequest(
  admin: AuthenticatedUser,
  requestId: string,
  input: PlanDecisionInput,
  meta: DecisionMeta = {},
) {
  const reason = assertReason(input.reason);
  if (!isUuid(requestId)) throw new NotFoundError('Plan request');

  const request = await platformDb.planRequest.findUnique({
    where: { id: requestId },
    select: { id: true, organizationId: true, plan: true, fromPlan: true, status: true },
  });
  if (!request) throw new NotFoundError('Plan request');
  if (request.status !== 'PENDING') throw alreadyAnswered();

  const approving = input.decision === 'APPROVE';
  const plan = findPlan(request.plan);
  if (approving && !plan) {
    throw new ValidationError('Requested plan is not in the catalogue', {
      userMessage: `The plan "${request.plan}" is no longer offered. Decline this request and ask the customer to choose again.`,
    });
  }

  await platformDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${request.organizationId}::text, true)`;

    const claimed = await tx.planRequest.updateMany({
      where: { id: request.id, organizationId: request.organizationId, status: 'PENDING' },
      data: {
        status: approving ? 'APPROVED' : 'DECLINED',
        decidedById: admin.id,
        decidedAt: clock.now(),
        decisionReason: reason,
      },
    });
    if (claimed.count !== 1) throw alreadyAnswered();

    let before: Record<string, unknown> = { status: 'PENDING', plan: request.plan };
    let after: Record<string, unknown> = { status: approving ? 'APPROVED' : 'DECLINED' };

    if (approving && plan) {
      const subscription = await tx.subscription.findFirst({
        where: { organizationId: request.organizationId },
        select: { id: true, plan: true, status: true, limits: true },
      });
      if (!subscription) throw new NotFoundError('Subscription');

      await tx.subscription.update({
        where: { id: subscription.id },
        data: { plan: plan.id, status: 'ACTIVE', limits: { ...plan.limits } },
      });

      // The previous limits are kept here, so an approval can be undone by
      // hand from the record alone.
      before = {
        plan: subscription.plan,
        status: subscription.status,
        limits: subscription.limits,
      };
      after = { plan: plan.id, status: 'ACTIVE', limits: plan.limits };
    }

    await platformAudit(
      admin,
      {
        organizationId: request.organizationId,
        action: approving ? 'subscription.plan_changed' : 'subscription.plan_request_declined',
        resourceType: 'PlanRequest',
        resourceId: request.id,
        reason,
        before,
        after,
        ip: meta.ip,
        userAgent: meta.userAgent,
        correlationId: meta.correlationId,
      },
      tx,
    );
  });

  return {
    id: request.id,
    status: approving ? ('APPROVED' as const) : ('DECLINED' as const),
    plan: request.plan,
  };
}

function alreadyAnswered(): ConflictError {
  return new ConflictError('Plan request already decided', {
    userMessage: 'This request has already been answered or withdrawn. Reload to see it.',
  });
}
