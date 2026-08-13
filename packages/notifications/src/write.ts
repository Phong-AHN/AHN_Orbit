import type { TenantContext } from '@orbit/core';
import type { TenantDb } from '@orbit/db';
import { logger } from '@orbit/observability';
import { channelsFor, type DeliveryPreferences } from './channels.js';
import { notificationContent } from './content.js';
import { resolveRecipients, type RecipientScope } from './recipients.js';
import type { NotificationEvent, NotificationResource } from './types.js';

/**
 * Writing notifications — the single writer (T1.15).
 *
 * Takes the `db` handle rather than opening its own transaction, so a caller
 * that is already inside one gets the notification committed with the change it
 * describes. That is what T1.7's account-health path needs: an account marked
 * broken with nobody told would be worse than either outcome alone.
 *
 * Callers that are *not* inside a meaningful transaction (the queue processor)
 * simply pass their own scoped client and get the same behaviour.
 *
 * One row per (recipient × channel). Today that is one row per recipient,
 * because `channelsFor` returns in-app only — see `channels.ts` for how email
 * arrives later without touching this function or any caller.
 */

export interface NotifyInput {
  event: NotificationEvent;
  resource: NotificationResource;
  /** Extra scope the visibility check needs for post-scoped events. */
  scope?: Omit<RecipientScope, 'workspaceId' | 'brandId'>;
  /** Named individuals with a stake — still filtered by visibility. */
  includeUsers?: readonly (string | null | undefined)[];
  /** Never tell someone about their own action. */
  excludeUsers?: readonly (string | null | undefined)[];
  preferences?: DeliveryPreferences;
}

export interface NotifyResult {
  recipients: number;
  rows: number;
}

export async function notify(
  db: TenantDb,
  ctx: TenantContext,
  input: NotifyInput,
): Promise<NotifyResult> {
  const { event, resource } = input;

  const recipients = await resolveRecipients(
    db,
    ctx.organizationId,
    event.type,
    {
      workspaceId: resource.workspaceId,
      brandId: resource.brandId,
      ...input.scope,
    },
    { includeUsers: input.includeUsers, excludeUsers: input.excludeUsers },
  );

  if (recipients.length === 0) {
    // Not an error. A workspace can legitimately have nobody holding the right,
    // and a self-caused event can exclude its only candidate. Worth being able
    // to see, though, because "nobody was told" and "nothing happened" look the
    // same from the outside.
    logger.info('notification had no recipients', {
      type: event.type,
      organizationId: ctx.organizationId,
      resourceType: resource.resourceType,
      resourceId: resource.resourceId,
    });
    return { recipients: 0, rows: 0 };
  }

  const content = notificationContent(event);
  const channels = channelsFor(event.type, input.preferences);

  const rows = recipients.flatMap((userId) =>
    channels.map((channel) => ({
      organizationId: ctx.organizationId,
      userId,
      type: event.type,
      title: content.title,
      body: content.body,
      resourceType: resource.resourceType,
      resourceId: resource.resourceId,
      channel,
    })),
  );

  await db.notification.createMany({ data: rows });

  logger.info('notifications recorded', {
    type: event.type,
    organizationId: ctx.organizationId,
    recipients: recipients.length,
    rows: rows.length,
  });

  return { recipients: recipients.length, rows: rows.length };
}
