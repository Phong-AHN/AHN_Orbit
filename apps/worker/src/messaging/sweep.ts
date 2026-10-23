import { serverEnv } from '@orbit/config';
import { clock } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { logger } from '@orbit/observability';
import { capabilitiesFor, isSupported } from '@orbit/providers';
import { enqueue } from '@orbit/queue';

/**
 * The conversation backfill sweep (**D-107**).
 *
 * Webhooks are the mechanism; this is the backstop. It queues one `messaging`
 * job per account that can receive messages, and each job reads the
 * conversations updated since the newest message stored — so a delivery Meta
 * gave up on, or one that arrived while the app was unsubscribed, still
 * reaches the inbox, if later.
 *
 * It is also what subscribes the accounts connected before messaging was
 * switched on: the job subscribes any account that has not been.
 *
 * Every half hour. Slower would leave a missed message waiting long enough to
 * matter against a 24-hour window; faster would spend the app's shared rate
 * limit re-reading conversations the webhooks already delivered.
 */

export const CONVERSATION_SYNC_INTERVAL_MS = 30 * 60 * 1_000;

const SWEEP_BATCH = 300;

/** Only these platforms have private messages today. */
const MESSAGING_PLATFORMS = ['FACEBOOK', 'INSTAGRAM'] as const;

export async function sweepConversations(correlationId: string): Promise<{
  accounts: number;
  failed: number;
}> {
  const platforms = MESSAGING_PLATFORMS.filter((platform) => isSupported(platform));
  if (platforms.length === 0) return { accounts: 0, failed: 0 };

  const candidates = await platformDb.socialAccount.findMany({
    where: {
      platform: { in: [...platforms] },
      deletedAt: null,
      status: 'ACTIVE',
    },
    select: {
      id: true,
      organizationId: true,
      platform: true,
      accountType: true,
      webhookExternalId: true,
    },
    orderBy: { connectedAt: 'desc' },
    take: SWEEP_BATCH,
  });

  const bucket = Math.floor(clock.now().getTime() / CONVERSATION_SYNC_INTERVAL_MS);
  const webhooksConfigured = Boolean(serverEnv().FACEBOOK_WEBHOOK_VERIFY_TOKEN);
  let accounts = 0;
  let failed = 0;

  for (const account of candidates) {
    // Decided by the descriptor, which is how a deployment with messaging
    // switched off queues nothing for it — except an account still waiting to
    // be subscribed to webhooks, which the same job does.
    const messaging = capabilitiesFor(account.platform, account.accountType).messaging.supported;
    const needsSubscription = webhooksConfigured && !account.webhookExternalId;
    if (!messaging && !needsSubscription) continue;

    try {
      await enqueue(
        'messaging',
        { organizationId: account.organizationId, correlationId, socialAccountId: account.id },
        { jobId: `conversations-${account.id}-${bucket}` },
      );
      accounts += 1;
    } catch (error) {
      failed += 1;
      logger.error('failed to enqueue a conversation sync', {
        socialAccountId: account.id,
        organizationId: account.organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { accounts, failed };
}
