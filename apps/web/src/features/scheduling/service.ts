import {
  ConflictError,
  NotFoundError,
  ValidationError,
  assertSchedulable,
  assertValidTimeZone,
  clock,
  contentHash,
  earliestSlot,
  resolveSchedule,
  zonedDayRange,
  type TenantContext,
} from '@orbit/core';
import { withTenant, type TenantDb } from '@orbit/db';
import { assertCan } from '@orbit/rbac';
import { logger } from '@orbit/observability';
import { audit, type AuditInput } from '@/server/audit';
import { transitionPost } from '@/features/posts/service';
import { validatePost } from '@/features/posts/validation';

/**
 * Scheduling (SRS §12, §13; assumptions C5 and C10).
 *
 * Three rules shape this file:
 *
 *   • **Everything is stored UTC.** A timezone appears only where a human
 *     expresses an intent or reads one back. The workspace's zone decides what
 *     "9am Tuesday" means (C5); the user's zone is display only.
 *   • **The status change goes through the state machine.** Scheduling is
 *     `APPROVED → SCHEDULED`, so `transitionPost` enforces the permission, the
 *     validation and the audit row exactly as every other move does.
 *   • **The database is the source of truth for what is scheduled**, not the
 *     queue. Nothing is enqueued here; a 30s sweep finds due variants. That is
 *     what makes rescheduling and cancellation ordinary updates rather than
 *     queue surgery (docs/ARCHITECTURE.md §5.1).
 */

const SCHEDULE_SELECT = {
  id: true,
  status: true,
  workspaceId: true,
  brandId: true,
  createdById: true,
  scheduledFor: true,
  timezone: true,
} as const;

/** The zone a post's schedule resolves in. Always the workspace's (C5). */
async function workspaceZone(db: TenantDb, workspaceId: string): Promise<string> {
  const workspace = await db.workspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    select: { timezone: true },
  });
  if (!workspace) throw new NotFoundError('Workspace');

  assertValidTimeZone(workspace.timezone);
  return workspace.timezone;
}

export interface ScheduleInput {
  /** Wall-clock time in the workspace's zone. Mutually exclusive with the slot. */
  localTime?:
    { year: number; month: number; day: number; hour: number; minute: number } | undefined;
  /** Take the next configured queue slot instead of naming a time. */
  useNextQueueSlot?: boolean | undefined;
  /**
   * An explicit UTC instant. Accepted for API clients that have already done
   * the conversion, and still validated against lead-time bounds.
   */
  scheduledForUtc?: string | undefined;
}

/**
 * Resolve an intent into the instant to store.
 *
 * A nonexistent wall time is **rejected** rather than shifted: the user picked
 * it, so they should be told the clocks go forward and pick again. Recurring
 * queue slots shift instead, because silently dropping one week's post twice a
 * year is worse (decision D-023).
 */
async function resolveIntent(
  db: TenantDb,
  workspaceId: string,
  input: ScheduleInput,
): Promise<{ scheduledFor: Date; timeZone: string; ambiguous: boolean }> {
  const timeZone = await workspaceZone(db, workspaceId);

  const given = [input.localTime, input.useNextQueueSlot, input.scheduledForUtc].filter(Boolean);
  if (given.length !== 1) {
    throw new ValidationError('Exactly one scheduling intent is required', {
      userMessage: 'Choose a time, or use the next queue slot.',
      details: [
        {
          field: 'scheduledFor',
          issue: 'provide one of localTime, useNextQueueSlot, scheduledForUtc',
        },
      ],
    });
  }

  if (input.useNextQueueSlot) {
    const slots = await db.queueSlot.findMany({
      where: { workspaceId, isActive: true },
      select: { dayOfWeek: true, localTime: true, timezone: true },
    });

    const scheduledFor = earliestSlot(
      slots.map((slot) => ({
        dayOfWeek: slot.dayOfWeek,
        localTime: slot.localTime,
        // A slot may carry its own zone (a workspace posting to two markets);
        // the workspace zone is the fallback.
        timeZone: slot.timezone || timeZone,
      })),
      clock.now(),
    );

    return { scheduledFor, timeZone, ambiguous: false };
  }

  if (input.scheduledForUtc) {
    const scheduledFor = new Date(input.scheduledForUtc);
    if (Number.isNaN(scheduledFor.getTime())) {
      throw new ValidationError('Invalid scheduledFor', {
        userMessage: "That date doesn't look right.",
        details: [{ field: 'scheduledForUtc', issue: 'not a valid ISO 8601 instant' }],
      });
    }
    return { scheduledFor, timeZone, ambiguous: false };
  }

  const resolved = resolveSchedule({
    localTime: input.localTime as NonNullable<ScheduleInput['localTime']>,
    timeZone,
  });

  return {
    scheduledFor: resolved.scheduledFor,
    timeZone: resolved.timeZone,
    ambiguous: resolved.ambiguous,
  };
}

/**
 * Stamp the schedule onto the post and every publishable variant.
 *
 * Also computes each variant's `contentHash` from its *effective* content —
 * the override where present, the master copy otherwise. That hash is layer 1
 * of the idempotency key and layer 4's reconciliation fingerprint, so it has to
 * be settled before anything is queued, not derived later from content that may
 * since have changed.
 */
async function applySchedule(
  db: TenantDb,
  postId: string,
  scheduledFor: Date,
  timeZone: string,
): Promise<number> {
  const post = await db.post.findFirst({
    where: { id: postId, deletedAt: null },
    select: {
      body: true,
      media: {
        where: { postVariantId: null },
        orderBy: { position: 'asc' },
        select: { mediaAssetId: true },
      },
      variants: {
        where: { deletedAt: null, status: { in: ['DRAFT', 'SCHEDULED'] } },
        select: {
          id: true,
          body: true,
          linkUrl: true,
          media: { orderBy: { position: 'asc' }, select: { mediaAssetId: true } },
        },
      },
    },
  });
  if (!post) throw new NotFoundError('Post');

  await db.post.update({
    where: { id: postId },
    data: { scheduledFor, timezone: timeZone },
  });

  for (const variant of post.variants) {
    const media = variant.media.length > 0 ? variant.media : post.media;

    await db.postVariant.update({
      where: { id: variant.id },
      data: {
        scheduledFor,
        status: 'SCHEDULED',
        contentHash: contentHash({
          body: variant.body.length > 0 ? variant.body : post.body,
          linkUrl: variant.linkUrl,
          mediaKeys: media.map((m) => m.mediaAssetId),
        }),
      },
    });
  }

  return post.variants.length;
}

// ── Schedule ────────────────────────────────────────────────────────────────

/**
 * Schedule an approved post.
 *
 * The status change runs through `transitionPost`, which checks `post:schedule`
 * against the state machine and re-runs validation — so a post that stopped
 * being publishable since approval cannot be scheduled.
 */
export async function schedulePost(
  ctx: TenantContext,
  postId: string,
  input: ScheduleInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const resolved = await withTenant(ctx, async (db) => {
    const post = await db.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: SCHEDULE_SELECT,
    });
    if (!post) throw new NotFoundError('Post');

    const intent = await resolveIntent(db, post.workspaceId, input);
    assertSchedulable(intent.scheduledFor, clock.now());

    return { post, ...intent };
  });

  const updated = await transitionPost(ctx, postId, 'SCHEDULED', fingerprint, {
    onTransition: async (db) => {
      const variants = await applySchedule(db, postId, resolved.scheduledFor, resolved.timeZone);

      if (variants === 0) {
        // A post with nowhere to publish must not sit in SCHEDULED forever.
        throw new ValidationError('Post has no accounts to publish to', {
          userMessage: 'Choose at least one account before scheduling.',
          details: [{ field: 'socialAccountIds', issue: 'none selected' }],
        });
      }

      await audit(db, ctx, {
        action: 'post.scheduled',
        resourceType: 'Post',
        resourceId: postId,
        workspaceId: resolved.post.workspaceId,
        brandId: resolved.post.brandId,
        after: {
          scheduledFor: resolved.scheduledFor.toISOString(),
          timezone: resolved.timeZone,
          variants,
        },
        ...fingerprint,
      });
    },
  });

  if (resolved.ambiguous) {
    // The user picked a wall time that happens twice. We took the earlier one;
    // worth a log line so a support question has an answer.
    logger.info('scheduled at an ambiguous local time; took the earlier occurrence', {
      postId,
      scheduledFor: resolved.scheduledFor.toISOString(),
      timezone: resolved.timeZone,
    });
  }

  return { post: updated, scheduledFor: resolved.scheduledFor, timezone: resolved.timeZone };
}

/**
 * Move an already-scheduled post.
 *
 * Not a state transition — the post stays `SCHEDULED` — so the permission is
 * checked directly. `post:reschedule` exists precisely because moving a post
 * is a lesser act than scheduling it in the first place, and some roles hold
 * one without the other.
 *
 * Rescheduling changes the content hash's partner in the idempotency key (the
 * instant), so the sweep will derive a *different* key and any job already
 * enqueued for the old time is inert: the variant it names is no longer due at
 * that instant, and the publish engine's claim will find it moved.
 */
export async function reschedulePost(
  ctx: TenantContext,
  postId: string,
  input: ScheduleInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const post = await db.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: SCHEDULE_SELECT,
    });
    if (!post) throw new NotFoundError('Post');

    assertCan(ctx, 'post:reschedule', {
      workspaceId: post.workspaceId,
      brandId: post.brandId,
      createdById: post.createdById,
      status: post.status,
      // Moving a scheduled post is a scheduling act, not a content edit — the
      // edit lock must not apply (decision D-016).
      intent: 'TRANSITION',
    });

    if (post.status !== 'SCHEDULED') {
      throw new ConflictError('Only a scheduled post can be rescheduled', {
        userMessage: 'This post is not scheduled. Schedule it instead.',
        context: { status: post.status },
      });
    }

    // A variant already publishing or published cannot be moved; its moment has
    // passed and the record has to stand.
    const settled = await db.postVariant.count({
      where: { postId, status: { in: ['PUBLISHING', 'PUBLISHED'] } },
    });
    if (settled > 0) {
      throw new ConflictError('Some accounts have already been published to', {
        userMessage:
          'This post has already started publishing to at least one account and can no longer be moved.',
      });
    }

    const intent = await resolveIntent(db, post.workspaceId, input);
    assertSchedulable(intent.scheduledFor, clock.now());

    await applySchedule(db, postId, intent.scheduledFor, intent.timeZone);

    await audit(db, ctx, {
      action: 'post.rescheduled',
      resourceType: 'Post',
      resourceId: postId,
      workspaceId: post.workspaceId,
      brandId: post.brandId,
      before: { scheduledFor: post.scheduledFor?.toISOString() ?? null, timezone: post.timezone },
      after: {
        scheduledFor: intent.scheduledFor.toISOString(),
        timezone: intent.timeZone,
      },
      ...fingerprint,
    });

    const updated = await db.post.findFirstOrThrow({
      where: { id: postId },
      select: SCHEDULE_SELECT,
    });

    return { post: updated, scheduledFor: intent.scheduledFor, timezone: intent.timeZone };
  });
}

/**
 * Take a post off the schedule without cancelling it.
 *
 * Goes to `DRAFT` through the state machine, which voids approvals — reopening
 * approved content is exactly what this is, so a new round is required before
 * it can go out again.
 */
export async function unschedulePost(
  ctx: TenantContext,
  postId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return transitionPost(ctx, postId, 'DRAFT', fingerprint, {
    onTransition: async (db) => {
      await db.post.update({
        where: { id: postId },
        data: { scheduledFor: null, timezone: null },
      });
      await db.postVariant.updateMany({
        where: { postId, status: 'SCHEDULED' },
        data: { scheduledFor: null, status: 'DRAFT' },
      });
    },
  });
}

// ── The sweep ───────────────────────────────────────────────────────────────

// ── Calendar ────────────────────────────────────────────────────────────────

export interface CalendarFilter {
  /** Inclusive start of the window, as a wall date in the display zone. */
  from: { year: number; month: number; day: number };
  /** Exclusive end. */
  to: { year: number; month: number; day: number };
  timeZone: string;
  workspaceId?: string | undefined;
  brandId?: string | undefined;
  socialAccountId?: string | undefined;
  statuses?: readonly string[] | undefined;
  accessibleWorkspaces?: 'ALL' | readonly string[] | undefined;
}

/**
 * Posts in a date window (SRS §12).
 *
 * The window is expressed as wall dates in a zone and converted to UTC
 * instants here, so "June" means June where the viewer is rather than June in
 * UTC — a distinction that moves posts between months for anyone east of
 * Greenwich.
 */
export async function listCalendar(ctx: TenantContext, filter: CalendarFilter) {
  assertValidTimeZone(filter.timeZone);

  const from = zonedDayRange(filter.from, filter.timeZone).start;
  const to = zonedDayRange(filter.to, filter.timeZone).start;

  if (to.getTime() <= from.getTime()) {
    throw new ValidationError('Calendar window is empty or inverted', {
      userMessage: 'The end of the range must be after the start.',
      details: [{ field: 'to', issue: 'must be after from' }],
    });
  }

  // A month view is 31 days; a quarter is 92. Beyond that it is a report, not a
  // calendar, and should be paginated rather than loaded whole.
  if (to.getTime() - from.getTime() > 100 * 24 * 3_600_000) {
    throw new ValidationError('Calendar window is too large', {
      userMessage: 'Choose a shorter date range.',
      details: [{ field: 'to', issue: 'window may not exceed about three months' }],
    });
  }

  return withTenant(ctx, (db) =>
    db.post.findMany({
      where: {
        deletedAt: null,
        scheduledFor: { gte: from, lt: to },
        ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
        ...(filter.brandId ? { brandId: filter.brandId } : {}),
        ...(filter.statuses ? { status: { in: [...filter.statuses] as never } } : {}),
        ...(filter.socialAccountId
          ? { variants: { some: { socialAccountId: filter.socialAccountId, deletedAt: null } } }
          : {}),
        ...(filter.accessibleWorkspaces && filter.accessibleWorkspaces !== 'ALL'
          ? { workspaceId: { in: [...filter.accessibleWorkspaces] } }
          : {}),
      },
      select: {
        id: true,
        title: true,
        body: true,
        status: true,
        workspaceId: true,
        brandId: true,
        scheduledFor: true,
        timezone: true,
        publishedAt: true,
        variants: {
          where: { deletedAt: null },
          select: {
            id: true,
            platform: true,
            status: true,
            socialAccountId: true,
            scheduledFor: true,
            socialAccount: { select: { displayName: true } },
          },
        },
      },
      orderBy: { scheduledFor: 'asc' },
      take: 500,
    }),
  );
}

/** Permission-check helper for the schedule routes. */
export async function schedulingScope(ctx: TenantContext, postId: string) {
  return withTenant(ctx, async (db) => {
    const post = await db.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: SCHEDULE_SELECT,
    });
    if (!post) throw new NotFoundError('Post');
    return post;
  });
}

/** Re-export so routes can run the composer's validation before scheduling. */
export { validatePost };
