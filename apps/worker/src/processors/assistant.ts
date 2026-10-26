import { ASSISTANT_WORKER_CAPABILITIES } from '@orbit/auth';
import { logger } from '@orbit/observability';
import type { JobContext } from '@orbit/queue';
import { runAssistant } from '../assistant/run.js';
import { resolveTenantForJob } from '../context.js';

/**
 * Job entry point for the assistant queue: one conversation the AI assistant
 * may answer (**D-108**).
 *
 * Tenant from the conversation row, compared against the payload's claim
 * (D-021). The capability set reads messages and sends the assistant's own —
 * `message:reply_ai`, which no person holds and which cannot send under the
 * Human Agent tag.
 *
 * Not retried on failure: a reply that arrives late, or twice, is worse than
 * one a colleague sends instead. `runAssistant` hands over to a person on
 * anything it did not expect, so a thrown error here is a bug, logged and left.
 */
export async function processAssistant(job: JobContext<'assistant'>): Promise<void> {
  const { payload, correlationId } = job;

  const { ctx } = await resolveTenantForJob({
    queue: 'assistant',
    jobId: job.jobId,
    claimedOrganizationId: payload.organizationId,
    subject: { subjectType: 'socialConversation', subjectId: payload.conversationId },
    actorName: 'assistant-worker',
    capabilities: ASSISTANT_WORKER_CAPABILITIES,
    correlationId,
  });

  const outcome = await runAssistant({
    ctx,
    conversationId: payload.conversationId,
    correlationId,
  });

  logger.info('assistant job finished', { conversationId: payload.conversationId, outcome });
}
