import {
  ConflictError,
  NotFoundError,
  ValidationError,
  clock,
  isUserPrincipal,
  type PlanRequestStatus,
  type TenantContext,
} from '@orbit/core';
import { Prisma, withTenant } from '@orbit/db';
import { audit, type AuditInput } from '@/server/audit';
import { getCreditStatus } from '@/features/ai/service';
import type { PlanRequestInput } from './contracts';
import { findPlan, hasNoLimits, planName, readPlanLimits, type PlanLimits } from './plans';

/**
 * An organization's plan, what it uses, and asking for another (D-116).
 *
 * The organization side of a manual upgrade. An Owner asks for a plan here; a
 * platform administrator approves or declines it from the admin surface
 * (`features/admin/plans.ts`), which is the only place a plan is applied.
 * Nothing in this file changes `Subscription`.
 *
 * Every read and write goes through `withTenant`, so a request id from another
 * organization is simply not found.
 */

/** How long a decided request stays on the plan page. */
const RECENT_DECISION_MS = 30 * 24 * 60 * 60 * 1000;

export interface PlanUsage {
  workspaces: number;
  socialAccounts: number;
  aiCreditsThisMonth: number;
  storageBytes: number;
}

export interface PlanRequestSummary {
  id: string;
  plan: string;
  planName: string;
  status: PlanRequestStatus;
  note: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  decisionReason: string | null;
}

export interface PlanOverview {
  plan: { id: string; name: string };
  status: string;
  limits: PlanLimits;
  /** No limit applies at all (the internal organizations of D-113). */
  unlimited: boolean;
  usage: PlanUsage;
  pendingRequest: PlanRequestSummary | null;
  /** The last approved or declined request, if it was decided recently. */
  recentDecision: PlanRequestSummary | null;
}

const REQUEST_SELECT = {
  id: true,
  plan: true,
  status: true,
  note: true,
  createdAt: true,
  decidedAt: true,
  decisionReason: true,
} as const;

function summarize(row: {
  id: string;
  plan: string;
  status: PlanRequestStatus;
  note: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  decisionReason: string | null;
}): PlanRequestSummary {
  return { ...row, planName: planName(row.plan) };
}

/**
 * The plan page's data.
 *
 * Usage is counted the way each limit check counts it, so the page and the
 * refusal agree: clients not deleted, accounts not deleted and not staged,
 * AI requests since the first of the month (UTC), and the size of files not
 * deleted.
 */
export async function getPlanOverview(ctx: TenantContext): Promise<PlanOverview> {
  const [credits, rest] = await Promise.all([
    getCreditStatus(ctx),
    withTenant(ctx, async (db) => {
      const [subscription, workspaces, socialAccounts, storage, pending, decided] =
        await Promise.all([
          db.subscription.findFirst({ select: { plan: true, status: true, limits: true } }),
          db.workspace.count({ where: { deletedAt: null } }),
          db.socialAccount.count({ where: { deletedAt: null, status: { not: 'DISABLED' } } }),
          db.mediaAsset.aggregate({ where: { deletedAt: null }, _sum: { sizeBytes: true } }),
          db.planRequest.findFirst({ where: { status: 'PENDING' }, select: REQUEST_SELECT }),
          db.planRequest.findFirst({
            where: { status: { in: ['APPROVED', 'DECLINED'] } },
            orderBy: { decidedAt: 'desc' },
            select: REQUEST_SELECT,
          }),
        ]);
      return { subscription, workspaces, socialAccounts, storage, pending, decided };
    }),
  ]);

  if (!rest.subscription) throw new NotFoundError('Subscription');

  const limits = readPlanLimits(rest.subscription.limits);
  const now = clock.now().getTime();
  const recent =
    rest.decided?.decidedAt && now - rest.decided.decidedAt.getTime() <= RECENT_DECISION_MS
      ? summarize(rest.decided)
      : null;

  return {
    plan: { id: rest.subscription.plan, name: planName(rest.subscription.plan) },
    status: rest.subscription.status,
    limits,
    unlimited: hasNoLimits(limits),
    usage: {
      workspaces: rest.workspaces,
      socialAccounts: rest.socialAccounts,
      aiCreditsThisMonth: credits.used,
      storageBytes: rest.storage._sum.sizeBytes ?? 0,
    },
    pendingRequest: rest.pending ? summarize(rest.pending) : null,
    recentDecision: recent,
  };
}

/**
 * Ask to move to another plan.
 *
 * Refused when the organization is already on that plan, when it has no limits
 * to lift (approving would *add* caps to an internal organization), and when a
 * request is already waiting. The last is also a partial unique index, so two
 * Owners pressing the button at once get one request and one conflict.
 */
export async function requestPlanChange(
  ctx: TenantContext,
  input: PlanRequestInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
): Promise<PlanRequestSummary> {
  const target = findPlan(input.plan);
  if (!target?.requestable) {
    throw new ValidationError('Unknown plan', { userMessage: 'Choose one of the plans listed.' });
  }

  const note = input.note && input.note.length > 0 ? input.note : null;
  const requestedById = isUserPrincipal(ctx.principal) ? ctx.principal.userId : null;

  try {
    return await withTenant(ctx, async (db) => {
      const subscription = await db.subscription.findFirst({
        select: { id: true, plan: true, limits: true },
      });
      if (!subscription) throw new NotFoundError('Subscription');

      if (subscription.plan === target.id) {
        throw new ValidationError('Already on this plan', {
          userMessage: `Your organization is already on ${target.name}.`,
        });
      }

      if (hasNoLimits(readPlanLimits(subscription.limits))) {
        throw new ValidationError('No limits to lift', {
          userMessage:
            'Your organization has no plan limits at the moment, so there is nothing to upgrade.',
        });
      }

      const waiting = await db.planRequest.findFirst({
        where: { status: 'PENDING' },
        select: { id: true },
      });
      if (waiting) throw alreadyWaiting();

      const created = await db.planRequest.create({
        data: {
          organizationId: ctx.organizationId,
          fromPlan: subscription.plan,
          plan: target.id,
          note,
          requestedById,
        },
        select: REQUEST_SELECT,
      });

      await audit(db, ctx, {
        action: 'subscription.plan_requested',
        resourceType: 'PlanRequest',
        resourceId: created.id,
        after: { from: subscription.plan, to: target.id, ...(note ? { note } : {}) },
        ...fingerprint,
      });

      return summarize(created);
    });
  } catch (error) {
    // The partial unique index, when two requests race past the check above.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw alreadyWaiting();
    }
    throw error;
  }
}

/** Take back the request that is waiting. */
export async function withdrawPlanRequest(
  ctx: TenantContext,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
): Promise<PlanRequestSummary> {
  const decidedById = isUserPrincipal(ctx.principal) ? ctx.principal.userId : null;

  return withTenant(ctx, async (db) => {
    const waiting = await db.planRequest.findFirst({
      where: { status: 'PENDING' },
      select: { id: true },
    });
    if (!waiting) {
      throw new NotFoundError('Plan request', {
        userMessage: 'There is no plan change waiting to withdraw.',
      });
    }

    // Conditional on still being PENDING: an administrator may have decided it
    // between the read above and this write.
    const changed = await db.planRequest.updateMany({
      where: { id: waiting.id, status: 'PENDING' },
      data: { status: 'WITHDRAWN', decidedAt: clock.now(), decidedById },
    });
    if (changed.count !== 1) {
      throw new ConflictError('Plan request already decided', {
        userMessage: 'This request was answered a moment ago. Reload the page to see the outcome.',
      });
    }

    const row = await db.planRequest.findFirst({
      where: { id: waiting.id },
      select: REQUEST_SELECT,
    });
    if (!row) throw new NotFoundError('Plan request');

    await audit(db, ctx, {
      action: 'subscription.plan_request_withdrawn',
      resourceType: 'PlanRequest',
      resourceId: row.id,
      before: { status: 'PENDING', plan: row.plan },
      after: { status: 'WITHDRAWN' },
      ...fingerprint,
    });

    return summarize(row);
  });
}

function alreadyWaiting(): ConflictError {
  return new ConflictError('A plan request is already pending', {
    userMessage:
      'A plan change is already waiting. Withdraw it first if you would like a different plan.',
  });
}
