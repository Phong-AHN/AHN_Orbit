import { ForbiddenError, clock, isUserPrincipal, type TenantContext } from '@orbit/core';
import type { TenantDb } from '@orbit/db';
import { notificationTypesFor, type NotificationAudience } from './types.js';

/**
 * Reading your own notifications (T1.15, docs/API.md §2.11).
 *
 * The authorization rule here is **not** a permission — it is identity. There is
 * no `notification:read` grant and there should not be one, because no role
 * should be able to read another person's notifications. An Owner can see every
 * post in the organization; that is not a reason to see what an Account Manager
 * was told, when they read it, or what is still sitting unread in their bell.
 *
 * So every query in this file narrows on `userId` taken from the **session
 * principal**, never from a parameter. Tenant scoping still applies underneath
 * (the notification rows carry `organizationId` and the scoped client filters
 * on it), but tenant isolation alone would let one colleague read another's —
 * which is why the narrowing is the query itself and not a check around it.
 *
 * `markRead` follows the same shape: it is an `updateMany` with the user in the
 * predicate, so someone else's id simply matches nothing. There is no read-then-
 * authorize step to forget, and no 403 that would confirm the row exists.
 *
 * ## Audience is a second, separate narrowing
 *
 * The agency bell and the client portal read the **same table**, and one person
 * can be agency staff in one organization and a client in another. Identity
 * narrowing already stops them reading anyone else's inbox; `audience` stops
 * *their own* agency-side rows appearing in a portal, where the wording assumes
 * a reader who works at the agency.
 *
 * It is a filter on `type` rather than a stored column, so it needs no
 * migration and cannot fall out of step with `NOTIFICATION_AUDIENCE` — the one
 * place that says who a type is for.
 */

/** One page of the bell. Deliberately small — this is a glance, not an archive. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function requireUserId(ctx: TenantContext): string {
  if (!isUserPrincipal(ctx.principal)) {
    // A worker has no inbox. Reaching here means a background job tried to read
    // notifications, which is a programming error rather than a denial.
    throw new ForbiddenError('Notifications belong to a person', {
      userMessage: 'This action needs a signed-in user.',
      context: { actor: ctx.principal.actorName },
    });
  }
  return ctx.principal.userId;
}

export interface ListNotificationsOptions {
  unreadOnly?: boolean;
  limit?: number;
  /** `createdAt` of the last row seen, for cursor paging. */
  before?: Date;
  /**
   * Which surface is asking. Omitted means every type, which is what the
   * platform-operations view of a user would want — no caller does that today,
   * and the two real feeds both pass one.
   */
  audience?: NotificationAudience;
}

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string | null;
  resourceType: string | null;
  resourceId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export async function listNotifications(
  db: TenantDb,
  ctx: TenantContext,
  options: ListNotificationsOptions = {},
): Promise<{ notifications: NotificationView[]; nextCursor: string | null }> {
  const userId = requireUserId(ctx);
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const rows = await db.notification.findMany({
    where: {
      userId,
      // In-app only for now. When email rows start being written they are the
      // same notification through another channel, and the bell must not show
      // it twice (see `channels.ts`).
      channel: 'IN_APP',
      ...(options.unreadOnly ? { readAt: null } : {}),
      ...(options.before ? { createdAt: { lt: options.before } } : {}),
      ...audienceFilter(options.audience),
    },
    select: {
      id: true,
      type: true,
      title: true,
      body: true,
      resourceType: true,
      resourceId: true,
      readAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
  });

  const page = rows.slice(0, limit);
  const nextCursor =
    rows.length > limit ? (page[page.length - 1]?.createdAt.toISOString() ?? null) : null;

  return { notifications: page, nextCursor };
}

/**
 * Narrow to the types a surface is allowed to show.
 *
 * Derived from `NOTIFICATION_AUDIENCE` on every call rather than cached: the
 * cost is building a short array, and the alternative is a second list of types
 * that can disagree with the first.
 */
function audienceFilter(audience: NotificationAudience | undefined) {
  if (!audience) return {};
  return { type: { in: [...notificationTypesFor(audience)] } };
}

/**
 * The number on the bell.
 *
 * Takes the same audience as the list, and must: a count that included the
 * other surface's rows would put a badge on a bell whose panel then shows
 * nothing, which reads as the product losing a notification.
 */
export async function unreadCount(
  db: TenantDb,
  ctx: TenantContext,
  audience?: NotificationAudience,
): Promise<number> {
  const userId = requireUserId(ctx);

  return db.notification.count({
    where: { userId, channel: 'IN_APP', readAt: null, ...audienceFilter(audience) },
  });
}

/**
 * Mark one notification read.
 *
 * `updateMany` with the user in the predicate rather than a lookup followed by
 * a check: another person's id matches nothing, so the answer to "did I just
 * touch someone else's row?" is structurally no. Returns whether anything
 * changed, so a caller can 404 without the query ever having been able to
 * confirm existence across users.
 */
export async function markRead(
  db: TenantDb,
  ctx: TenantContext,
  notificationId: string,
): Promise<boolean> {
  const userId = requireUserId(ctx);

  const { count } = await db.notification.updateMany({
    // Already-read rows are excluded so the timestamp records when it was first
    // seen rather than the last time the page was refreshed.
    where: { id: notificationId, userId, readAt: null },
    data: { readAt: clock.now() },
  });

  return count > 0;
}

/** Mark everything currently unread as read. Returns how many were affected. */
export async function markAllRead(
  db: TenantDb,
  ctx: TenantContext,
  audience?: NotificationAudience,
): Promise<number> {
  const userId = requireUserId(ctx);

  const { count } = await db.notification.updateMany({
    // Scoped to the audience that asked. "Mark all read" in a client portal
    // must not silently clear the agency notifications of somebody who is both
    // — they were never shown them, so they cannot have read them.
    where: { userId, readAt: null, ...audienceFilter(audience) },
    data: { readAt: clock.now() },
  });

  return count;
}
