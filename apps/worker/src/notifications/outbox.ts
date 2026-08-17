import { clock } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { logger, logError } from '@orbit/observability';
import { renderEmail, type Mailer } from '@orbit/notifications';
import { serverEnv } from '@orbit/config';

/**
 * Draining the email outbox (SRS §18).
 *
 * **The notification row *is* the outbox.** An `EMAIL` row with no `emailedAt`
 * is a message owed; stamping it is the send receipt. That is why the in-app
 * record can never be lost to a mail problem — the row exists and is readable
 * the moment it is written, and email is a second delivery of something already
 * safely stored.
 *
 * ## Why a sweep rather than sending inline
 *
 * The notifications processor fans one event out to many recipients inside a
 * transaction. Calling a mail API in there would put a third-party HTTP request
 * inside a database transaction — the slowest possible place for one — and a
 * provider timeout would roll back notifications that ought to exist.
 *
 * ## Idempotence
 *
 * Each row is claimed by stamping `emailedAt` **after** a successful send. A
 * crash between the send and the stamp re-sends that one message on the next
 * pass; a crash before it sends nothing. Given the choice, a duplicate
 * notification email is a far smaller harm than a silent one about a failed
 * publish, so the ordering is deliberate.
 */

/** Rows per pass. Small: the sweep runs often and nobody is waiting. */
const BATCH = 100;

/** Older than this and the moment has passed — a stale alert is noise. */
const MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface OutboxResult {
  sent: number;
  failed: number;
  abandoned: number;
}

export async function drainEmailOutbox(mailer: Mailer): Promise<OutboxResult> {
  const now = clock.now();
  const cutoff = new Date(now.getTime() - MAX_AGE_MS);
  const result: OutboxResult = { sent: 0, failed: 0, abandoned: 0 };

  // Unscoped, like the other sweeps: "what is owed" is a platform-wide
  // question. Only the fields needed to render are selected, and the
  // organization is read for the sender line rather than trusted from anywhere.
  const pending = await platformDb.notification.findMany({
    where: { channel: 'EMAIL', emailedAt: null, createdAt: { gte: cutoff } },
    select: {
      id: true,
      type: true,
      title: true,
      body: true,
      resourceType: true,
      resourceId: true,
      organizationId: true,
      organization: { select: { name: true, slug: true } },
      user: { select: { email: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });

  // Anything past the window is stamped without sending: the in-app record
  // stays, and an alert about a publish that failed yesterday helps nobody
  // today. Stamped rather than left, so it stops being retried forever.
  const stale = await platformDb.notification.updateMany({
    where: { channel: 'EMAIL', emailedAt: null, createdAt: { lt: cutoff } },
    data: { emailedAt: now },
  });
  result.abandoned = stale.count;

  for (const notification of pending) {
    try {
      await mailer.send(
        renderEmail({
          to: notification.user.email,
          title: notification.title,
          body: notification.body ?? notification.title,
          url: linkFor(notification),
          organizationName: notification.organization.name,
        }),
      );

      // Stamped only after the provider accepted it.
      await platformDb.notification.update({
        where: { id: notification.id },
        data: { emailedAt: clock.now() },
      });

      result.sent += 1;
    } catch (error) {
      // One bad address must not stop the rest of the batch. The row stays
      // unstamped and is retried next pass, until it ages out of the window.
      result.failed += 1;
      logError('could not send a notification email', error, {
        notificationId: notification.id,
        organizationId: notification.organizationId,
      });
    }
  }

  if (result.sent > 0 || result.failed > 0 || result.abandoned > 0) {
    logger.info('email outbox drained', { ...result });
  }

  return result;
}

/**
 * Where the email points.
 *
 * Deep-links to the thing that needs attention rather than the dashboard —
 * an alert that lands somebody on a home page and makes them hunt is an alert
 * they stop opening.
 */
function linkFor(notification: {
  type: string;
  resourceType: string | null;
  resourceId: string | null;
  organization: { slug: string };
}): string {
  const base = `${serverEnv().APP_URL.replace(/\/$/, '')}/orgs/${notification.organization.slug}`;

  if (notification.resourceType === 'Post' && notification.resourceId) {
    return `${base}/posts/${notification.resourceId}`;
  }

  if (notification.type.startsWith('social_account.')) return `${base}/settings/accounts`;
  if (notification.type.startsWith('publishing.')) return `${base}/publishing`;

  return `${base}/dashboard`;
}
