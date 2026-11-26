import { clock, isAppError, ValidationError, type TenantContext } from '@orbit/core';
import { NOTIFICATION_WORKER_CAPABILITIES } from '@orbit/auth';
import { withTenant, type Prisma, type TenantDb } from '@orbit/db';
import { logger } from '@orbit/observability';
import {
  isSlackEvent,
  openSlackWebhook,
  readSlackSettings,
  renderSlackMessage,
  sendSlackMessage,
  withSlackSettings,
  type SlackEventType,
  type SlackNotice,
} from '@orbit/notifications';
import { CredentialCipher } from '@orbit/providers';
import type { JobContext } from '@orbit/queue';
import { resolveTenantForJob } from '../context.js';
import { linkFor } from '../notifications/links.js';
import { describeNotification } from './notifications.js';

/**
 * One message to an organization's Slack channel (D-129).
 *
 * Everything is decided when the job runs, not when it was queued: whether the
 * organization still has Slack connected, whether it still wants this kind of
 * event, and what the post is called now. A job queued before somebody
 * disconnected Slack sends nothing.
 *
 * Retries are the queue's: an outage or a rate limit throws a retryable error.
 * A webhook Slack refuses for good is recorded on the organization instead of
 * thrown, so it is said once, on the settings page, rather than failing every
 * event after it.
 */

let cipher: CredentialCipher | undefined;

export async function processSlack(job: JobContext<'slack'>): Promise<void> {
  const { payload, correlationId } = job;

  if (!isSlackEvent(payload.event)) {
    throw new ValidationError(`Not a Slack event: ${payload.event}`, {
      context: { event: payload.event, jobId: job.jobId },
    });
  }

  const event = payload.event;

  const { ctx } = await resolveTenantForJob({
    queue: 'slack',
    jobId: job.jobId,
    claimedOrganizationId: payload.organizationId,
    subject: {
      subjectType:
        payload.resourceType === 'PostVariant'
          ? 'postVariant'
          : payload.resourceType === 'Post'
            ? 'post'
            : 'socialAccount',
      subjectId: payload.resourceId,
    },
    actorName: 'slack-worker',
    capabilities: NOTIFICATION_WORKER_CAPABILITIES,
    correlationId,
  });

  const prepared = await withTenant(ctx, async (db) => {
    const organization = await db.organization.findFirst({
      select: { name: true, slug: true, settings: true },
    });
    const slack = readSlackSettings(organization?.settings);

    // Disconnected, refused, or this event switched off since it was queued.
    if (!organization || !slack || slack.failure || !slack.events.includes(event)) return null;

    const notice = await describeForSlack(db, event, payload.resourceId, organization);
    return notice ? { webhook: slack.webhook, notice } : null;
  });

  if (!prepared) {
    logger.info('slack message not sent; nothing to send or not wanted', {
      event,
      organizationId: ctx.organizationId,
    });
    return;
  }

  cipher ??= new CredentialCipher();
  const url = openSlackWebhook(cipher, ctx.organizationId, prepared.webhook);

  try {
    await sendSlackMessage(url, renderSlackMessage(prepared.notice));
  } catch (error) {
    if (isAppError(error) && error.code === 'PROVIDER_PERMISSION_ERROR') {
      await recordRefusal(ctx, prepared.webhook, slackCode(error));
      return;
    }
    throw error;
  }

  logger.info('slack message sent', { event, organizationId: ctx.organizationId });
}

/** The facts for the message, or `null` when the subject has gone. */
async function describeForSlack(
  db: TenantDb,
  event: SlackEventType,
  resourceId: string,
  organization: { name: string; slug: string },
): Promise<SlackNotice | null> {
  const described =
    event === 'social_account.needs_reconnect'
      ? await describeAccount(db, resourceId)
      : await describeNotification(db, event, resourceId);

  if (!described) return null;

  const { resource } = described;
  const [workspace, brand] = await Promise.all([
    db.workspace.findFirst({ where: { id: resource.workspaceId }, select: { name: true } }),
    resource.brandId
      ? db.brand.findFirst({ where: { id: resource.brandId }, select: { name: true } })
      : null,
  ]);

  return {
    event: described.event,
    url: linkFor({
      type: event,
      resourceType: resource.resourceType,
      resourceId: resource.resourceId,
      organization,
    }),
    organizationName: organization.name,
    workspaceName: workspace?.name ?? null,
    brandName: brand?.name ?? null,
  };
}

/**
 * An account that needs reconnecting. Written inline by the health check, so
 * the notifications processor has no description of it to share.
 *
 * Nothing is said if it has already recovered by the time this runs.
 */
async function describeAccount(db: TenantDb, accountId: string) {
  const account = await db.socialAccount.findFirst({
    where: { id: accountId, deletedAt: null },
    select: {
      id: true,
      displayName: true,
      status: true,
      healthError: true,
      workspaceId: true,
      brandId: true,
    },
  });

  if (!account || account.status === 'ACTIVE') return null;

  return {
    event: {
      type: 'social_account.needs_reconnect' as const,
      accountName: account.displayName,
      reason: account.healthError,
    },
    resource: {
      resourceType: 'SocialAccount' as const,
      resourceId: account.id,
      workspaceId: account.workspaceId,
      brandId: account.brandId,
    },
  };
}

/**
 * Slack refused the webhook for good: say so on the organization.
 *
 * Only if the webhook is still the one that was refused — somebody may have
 * connected a new one while this message was on its way.
 */
async function recordRefusal(ctx: TenantContext, webhook: string, reason: string): Promise<void> {
  await withTenant(ctx, async (db) => {
    const organization = await db.organization.findFirst({ select: { settings: true } });
    const slack = readSlackSettings(organization?.settings);
    if (!slack || slack.webhook !== webhook) return;

    await db.organization.update({
      where: { id: ctx.organizationId },
      data: {
        settings: withSlackSettings(organization?.settings, {
          ...slack,
          failure: { reason, at: clock.now().toISOString() },
        }) as Prisma.InputJsonValue,
      },
    });
  });

  logger.warn('slack refused the webhook; stopped sending until it is connected again', {
    organizationId: ctx.organizationId,
    reason,
  });
}

/** Slack's own short code (`no_service`, `channel_is_archived`), if it gave one. */
function slackCode(error: unknown): string {
  const code =
    error && typeof error === 'object' && 'providerCode' in error
      ? (error as { providerCode?: unknown }).providerCode
      : undefined;
  return typeof code === 'string' && code.length > 0 ? code.slice(0, 60) : 'refused';
}
