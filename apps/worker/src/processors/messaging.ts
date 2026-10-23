import { MESSAGING_WORKER_CAPABILITIES } from '@orbit/auth';
import { serverEnv } from '@orbit/config';
import { logger } from '@orbit/observability';
import { enqueue, type JobContext } from '@orbit/queue';
import { resolveTenantForJob } from '../context.js';
import { syncConversations } from '../messaging/ingest.js';

/**
 * Job entry point for the messaging queue: one account's conversation
 * backfill (**D-107**).
 *
 * Tenant from the account row, compared against the payload's claim (D-021).
 * The capability set reads messages and cannot send one.
 */
export async function processMessaging(job: JobContext<'messaging'>): Promise<void> {
  const { payload, correlationId } = job;

  const { ctx } = await resolveTenantForJob({
    queue: 'messaging',
    jobId: job.jobId,
    claimedOrganizationId: payload.organizationId,
    subject: { subjectType: 'socialAccount', subjectId: payload.socialAccountId },
    actorName: 'messaging-worker',
    capabilities: MESSAGING_WORKER_CAPABILITIES,
    correlationId,
  });

  const result = await syncConversations({
    ctx,
    socialAccountId: payload.socialAccountId,
    ...(payload.cursor ? { cursor: payload.cursor } : {}),
    // Webhooks are configured when there is a verify token to answer Meta's
    // handshake with; without one, nothing would ever be delivered.
    subscribe: Boolean(serverEnv().FACEBOOK_WEBHOOK_VERIFY_TOKEN),
  });

  if (result.kind === 'SKIPPED') {
    logger.debug('conversation sync skipped', {
      reason: result.reason,
      socialAccountId: payload.socialAccountId,
    });
    return;
  }

  // More conversations than one page: continue as a new job, behind other
  // tenants' work, rather than holding this slot in a loop.
  if (result.nextCursor) {
    await enqueue('messaging', {
      organizationId: ctx.organizationId,
      correlationId,
      socialAccountId: payload.socialAccountId,
      cursor: result.nextCursor,
    });
  }

  logger.info('conversation sync complete', {
    socialAccountId: payload.socialAccountId,
    conversations: result.conversations,
    created: result.created,
    continued: Boolean(result.nextCursor),
  });
}
