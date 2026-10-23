import { logger } from '@orbit/observability';
import type { JobContext } from '@orbit/queue';
import { processWebhookEvent } from '../messaging/webhooks.js';

/**
 * Job entry point for the webhooks queue (**D-107**).
 *
 * Thin, like the other processors. The payload is a stored event's id and
 * nothing else; which tenants the event belongs to is worked out inside, per
 * matching account, from the account rows themselves.
 */
export async function processWebhooks(job: JobContext<'webhooks'>): Promise<void> {
  const result = await processWebhookEvent({
    webhookEventId: job.payload.webhookEventId,
    jobId: job.jobId,
    correlationId: job.correlationId,
  });

  logger.debug('webhook event processed', {
    webhookEventId: job.payload.webhookEventId,
    ...result,
  });
}
