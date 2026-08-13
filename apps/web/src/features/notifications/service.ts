import { NotFoundError, type TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';
import {
  listNotifications,
  markAllRead,
  markRead,
  unreadCount,
  type ListNotificationsOptions,
} from '@orbit/notifications';

/**
 * The web app's view of a person's notifications (T1.15).
 *
 * A thin seam over `@orbit/notifications`, which is where the rules live — most
 * importantly that every query narrows on the **session principal's** user id,
 * never on a parameter. This file exists so route handlers keep the shape every
 * other feature has (`service.ts` taking `ctx` first and using `withTenant`),
 * not because it adds logic.
 */

export async function listForUser(ctx: TenantContext, options: ListNotificationsOptions = {}) {
  return withTenant(ctx, (db) => listNotifications(db, ctx, options));
}

export async function unreadCountForUser(ctx: TenantContext): Promise<number> {
  return withTenant(ctx, (db) => unreadCount(db, ctx));
}

/**
 * Mark one notification read.
 *
 * A row belonging to somebody else matches nothing, and that is reported as a
 * 404 rather than a 403 — the same rule the rest of the API follows, because a
 * 403 would confirm the notification exists (docs/API.md §1).
 */
export async function markReadForUser(ctx: TenantContext, notificationId: string): Promise<void> {
  const changed = await withTenant(ctx, (db) => markRead(db, ctx, notificationId));

  if (!changed) {
    // Either it does not exist, belongs to someone else, or was already read.
    // Only the last is benign, and telling the three apart is not worth a
    // second query that could distinguish them for an attacker too.
    const exists = await withTenant(ctx, (db) => unreadOrOwn(db, ctx, notificationId));
    if (!exists) throw new NotFoundError('Notification');
  }
}

/** Did this user already have (and read) this notification? */
async function unreadOrOwn(
  db: Parameters<typeof markRead>[0],
  ctx: TenantContext,
  notificationId: string,
): Promise<boolean> {
  const userId = ctx.principal.kind === 'USER' ? ctx.principal.userId : null;
  if (!userId) return false;

  const found = await db.notification.findFirst({
    where: { id: notificationId, userId },
    select: { id: true },
  });

  return found !== null;
}

export async function markAllReadForUser(ctx: TenantContext): Promise<number> {
  return withTenant(ctx, (db) => markAllRead(db, ctx));
}
