import { NotFoundError, clock, type TenantContext } from '@orbit/core';
import { withTenant, type TenantDb } from '@orbit/db';
import { notify } from '@orbit/notifications';
import { logger } from '@orbit/observability';
import {
  capabilitiesFor,
  getProvider,
  type ConversationParticipant,
  type DirectMessage,
} from '@orbit/providers';
import { scheduleAssistant } from '../assistant/run.js';
import { loadAccountCredential } from '../credentials.js';

/**
 * Writing private messages into the inbox (**D-107**).
 *
 * Two ways in, one way to write. A webhook delivers one message as it happens;
 * the backfill reads whole conversations from the platform's Conversations
 * API. Both end in `recordMessage`, so a message is deduplicated, a
 * conversation reopened and a notification raised by the same rules whichever
 * path saw it first.
 *
 * ## The rules that matter
 *
 * - **Idempotent on the platform's message id.** Meta retries webhooks for a
 *   day and a half and the backfill re-reads what webhooks already brought, so
 *   every message is expected to arrive more than once.
 * - **A message from the person reopens the conversation.** "Handled" means
 *   handled up to now; the person writing again is new work.
 * - **The brand answering from the platform's own app closes it** — but only
 *   if the answer is newer than the person's latest message. Deliveries arrive
 *   out of order, and an old echo must not close a conversation somebody has
 *   since written in.
 * - **An unsend erases the words and keeps the row**, so the conversation still
 *   shows that something was said and then withdrawn.
 *
 * Like comment ingestion, this holds no permission to send. A reply goes out
 * from the request a person made.
 */

export type MessagingSkip = 'NOT_CONNECTED' | 'UNSUPPORTED' | 'MISSING_SCOPES';

interface AccountRow {
  id: string;
  workspaceId: string;
  brandId: string;
  platform: Parameters<typeof capabilitiesFor>[0];
  accountType: string | null;
  externalId: string;
  webhookExternalId: string | null;
  displayName: string;
  status: string;
}

async function loadAccount(ctx: TenantContext, socialAccountId: string): Promise<AccountRow> {
  const account = await withTenant(ctx, (db) =>
    db.socialAccount.findFirst({
      where: { id: socialAccountId, deletedAt: null },
      select: {
        id: true,
        workspaceId: true,
        brandId: true,
        platform: true,
        accountType: true,
        externalId: true,
        webhookExternalId: true,
        displayName: true,
        status: true,
      },
    }),
  );
  if (!account) throw new NotFoundError('Social account');
  return account;
}

function isConnected(account: AccountRow): boolean {
  return account.status !== 'REVOKED' && account.status !== 'DISABLED';
}

function messagingFor(account: AccountRow) {
  return capabilitiesFor(account.platform, account.accountType).messaging;
}

export interface RecordedMessage {
  conversationId: string;
  /** A row was written for this message. False for a duplicate. */
  created: boolean;
  /**
   * The conversation now needs somebody and did not before — new, or reopened.
   * The one moment a notification is worth raising.
   */
  opened: boolean;
}

/**
 * Write one message, its conversation, and what it does to the conversation's
 * state. Runs in one transaction, so the inbox never shows a message without
 * the state change it caused.
 */
export async function recordMessage(
  db: TenantDb,
  ctx: TenantContext,
  account: Pick<AccountRow, 'id' | 'workspaceId' | 'brandId'>,
  message: DirectMessage,
  options: {
    deleted?: boolean | undefined;
    participant?: ConversationParticipant | undefined;
    externalThreadId?: string | undefined;
  } = {},
): Promise<RecordedMessage> {
  const now = clock.now();
  const inbound = message.direction === 'INBOUND';

  let conversation = await db.socialConversation.findFirst({
    where: { socialAccountId: account.id, participantExternalId: message.participantExternalId },
    select: {
      id: true,
      state: true,
      lastMessageAt: true,
      lastInboundAt: true,
      lastHumanReplyAt: true,
    },
  });

  const isNew = !conversation;

  if (!conversation) {
    conversation = await db.socialConversation.create({
      data: {
        organizationId: ctx.organizationId,
        workspaceId: account.workspaceId,
        brandId: account.brandId,
        socialAccountId: account.id,
        participantExternalId: message.participantExternalId,
        ...(options.participant?.name ? { participantName: options.participant.name } : {}),
        ...(options.participant?.username
          ? { participantUsername: options.participant.username }
          : {}),
        ...(options.externalThreadId ? { externalThreadId: options.externalThreadId } : {}),
        lastMessageAt: message.sentAt,
        ...(inbound ? { lastInboundAt: message.sentAt } : { lastHumanReplyAt: message.sentAt }),
        // A conversation the brand started from its own app is not waiting on
        // anybody here; one the person started is.
        ...(inbound ? { state: 'NEW' as const } : { state: 'HANDLED' as const, handledAt: now }),
      },
      select: {
        id: true,
        state: true,
        lastMessageAt: true,
        lastInboundAt: true,
        lastHumanReplyAt: true,
      },
    });
  } else if (
    options.participant?.name ||
    options.participant?.username ||
    options.externalThreadId
  ) {
    // Platform facts only: a name the backfill learned, or the thread id.
    await db.socialConversation.update({
      where: { id: conversation.id },
      data: {
        ...(options.participant?.name ? { participantName: options.participant.name } : {}),
        ...(options.participant?.username
          ? { participantUsername: options.participant.username }
          : {}),
        ...(options.externalThreadId ? { externalThreadId: options.externalThreadId } : {}),
      },
    });
  }

  const existing = await db.socialMessage.findFirst({
    where: { socialAccountId: account.id, externalId: message.externalId },
    select: { id: true, deletedAt: true },
  });

  if (options.deleted) {
    // Erase what was said; keep that something was. A deletion for a message
    // we never stored has nothing to erase and leaves no trace.
    if (existing && !existing.deletedAt) {
      await db.socialMessage.update({
        where: { id: existing.id },
        data: { text: null, attachments: [], deletedAt: now },
      });
    }
    return { conversationId: conversation.id, created: false, opened: false };
  }

  // Already here: a webhook retry, the backfill re-reading, or the echo of a
  // reply Orbit itself sent. None of them changes anything.
  if (existing) return { conversationId: conversation.id, created: false, opened: false };

  await db.socialMessage.create({
    data: {
      organizationId: ctx.organizationId,
      conversationId: conversation.id,
      socialAccountId: account.id,
      externalId: message.externalId,
      direction: message.direction,
      ...(message.text ? { text: message.text } : {}),
      attachments: message.attachments.map((attachment) => ({
        type: attachment.type,
        ...(attachment.url ? { url: attachment.url } : {}),
      })),
      sentAt: message.sentAt,
    },
  });

  if (isNew) {
    return { conversationId: conversation.id, created: true, opened: inbound };
  }

  const newer = message.sentAt > conversation.lastMessageAt;
  const lastInboundAt = conversation.lastInboundAt;

  if (inbound) {
    const reopen = conversation.state === 'HANDLED';
    await db.socialConversation.update({
      where: { id: conversation.id },
      data: {
        ...(newer ? { lastMessageAt: message.sentAt } : {}),
        ...(!lastInboundAt || message.sentAt > lastInboundAt
          ? { lastInboundAt: message.sentAt }
          : {}),
        // The check constraint requires a NEW row to carry no handler.
        ...(reopen ? { state: 'NEW' as const, handledAt: null, handledById: null } : {}),
      },
    });
    return { conversationId: conversation.id, created: true, opened: reopen };
  }

  // The brand's own message, sent outside Orbit. It answers the person only if
  // it came after what they last said.
  const answers = !lastInboundAt || message.sentAt >= lastInboundAt;
  const lastHumanReplyAt = conversation.lastHumanReplyAt;
  await db.socialConversation.update({
    where: { id: conversation.id },
    data: {
      ...(newer ? { lastMessageAt: message.sentAt } : {}),
      // Somebody typed it in the platform's app, so the assistant stays out
      // (D-108). The assistant's own echo lands here too, and is put right by
      // the assistant when it records what it sent.
      ...(!lastHumanReplyAt || message.sentAt > lastHumanReplyAt
        ? { lastHumanReplyAt: message.sentAt }
        : {}),
      ...(answers && conversation.state === 'NEW'
        ? { state: 'HANDLED' as const, handledAt: now }
        : {}),
    },
  });

  return { conversationId: conversation.id, created: true, opened: false };
}

/**
 * One message from a webhook.
 *
 * Fetches the person's name the first time a conversation appears, because a
 * webhook carries only their id and an inbox of numbers is not usable. Best
 * effort: a refused profile lookup leaves the conversation nameless, not
 * missing.
 */
export async function ingestMessageEvent(input: {
  ctx: TenantContext;
  socialAccountId: string;
  message: DirectMessage;
  deleted?: boolean | undefined;
}): Promise<
  { kind: 'RECORDED'; recorded: RecordedMessage } | { kind: 'SKIPPED'; reason: MessagingSkip }
> {
  const { ctx, socialAccountId, message } = input;

  const account = await loadAccount(ctx, socialAccountId);
  if (!isConnected(account)) return { kind: 'SKIPPED', reason: 'NOT_CONNECTED' };
  if (!messagingFor(account).supported) return { kind: 'SKIPPED', reason: 'UNSUPPORTED' };

  const known = await withTenant(ctx, (db) =>
    db.socialConversation.findFirst({
      where: { socialAccountId, participantExternalId: message.participantExternalId },
      select: { participantName: true, participantUsername: true },
    }),
  );

  const participant =
    known?.participantName || known?.participantUsername
      ? undefined
      : await lookupParticipant(ctx, account, message.participantExternalId);

  const recorded = await withTenant(ctx, async (db) => {
    const result = await recordMessage(db, ctx, account, message, {
      deleted: input.deleted,
      participant,
    });

    if (result.opened) {
      const conversation = await db.socialConversation.findFirst({
        where: { id: result.conversationId },
        select: { assignedToId: true },
      });

      await notify(db, ctx, {
        event: { type: 'message.received', accountName: account.displayName },
        resource: {
          resourceType: 'SocialConversation',
          resourceId: result.conversationId,
          workspaceId: account.workspaceId,
          brandId: account.brandId,
        },
        // Whoever it was handed to hears about it, whatever the fan-out says.
        includeUsers: [conversation?.assignedToId],
      });
    }

    return result;
  });

  // A new message from the customer: the assistant may answer it, if the
  // brand has it on. Best effort — a failure here leaves the conversation to
  // people, which is where it was anyway.
  if (recorded.created && message.direction === 'INBOUND' && !input.deleted) {
    try {
      await scheduleAssistant({
        ctx,
        conversationId: recorded.conversationId,
        messageExternalId: message.externalId,
        correlationId: ctx.correlationId,
      });
    } catch (error) {
      logger.warn('could not schedule the assistant', {
        conversationId: recorded.conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { kind: 'RECORDED', recorded };
}

async function lookupParticipant(
  ctx: TenantContext,
  account: AccountRow,
  participantExternalId: string,
): Promise<ConversationParticipant | undefined> {
  const provider = getProvider(account.platform);
  if (!provider.fetchParticipant) return undefined;

  try {
    const credential = await loadAccountCredential(ctx, account.id);
    return await provider.fetchParticipant({
      credential,
      account: { externalId: account.externalId },
      participantExternalId,
    });
  } catch (error) {
    logger.debug('could not read a message sender profile', {
      socialAccountId: account.id,
      reason: (error as { code?: string }).code ?? 'unknown',
    });
    return undefined;
  }
}

export type ConversationSyncResult =
  | { kind: 'SYNCED'; conversations: number; created: number; nextCursor?: string | undefined }
  | { kind: 'SKIPPED'; reason: MessagingSkip };

/** How far back a first sync reaches. Older history is not worth the quota. */
export const FIRST_SYNC_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * Re-read the newest messages already stored, in case one arrived while a
 * webhook was being retried. The unique key makes the overlap free.
 */
const SYNC_OVERLAP_MS = 10 * 60 * 1_000;

/**
 * One account's job: subscribe it to webhooks if it is not, then read the
 * conversations updated since the newest message stored.
 *
 * Subscribing lives here — and only here — because this is the job that both
 * a new connection and the periodic sweep produce. Accounts connected before
 * webhooks were configured are reached by the sweep; a new one by the connect
 * flow, which enqueues this. The subscription is independent of messaging: a
 * Page subscribed for comments alone still gets them as they are written.
 *
 * `subscribe` says whether the deployment has webhooks configured at all.
 * Subscribing an account to an app with no callback URL is harmless but
 * pointless, and every failure would be a log line about nothing.
 */
export async function syncConversations(input: {
  ctx: TenantContext;
  socialAccountId: string;
  cursor?: string | undefined;
  subscribe?: boolean | undefined;
}): Promise<ConversationSyncResult> {
  const { ctx, socialAccountId, cursor } = input;

  const account = await loadAccount(ctx, socialAccountId);
  if (!isConnected(account)) return { kind: 'SKIPPED', reason: 'NOT_CONNECTED' };

  const messaging = messagingFor(account);
  const provider = getProvider(account.platform);
  const credential = await loadAccountCredential(ctx, account.id);

  // Subscribed once is not subscribed for good. The fields are chosen when the
  // call is made — `feed` alone while messaging is off — so a Page subscribed
  // before messaging was switched on would never receive a message, and
  // `webhookExternalId` being set would keep it that way forever. That is what
  // happened on 2026-10-27. Re-subscribing is idempotent and replaces the
  // fields, so an account that can message is subscribed again on every pass.
  const resubscribe =
    messaging.supported && messaging.scopes.every((s) => credential.scopes.includes(s));
  if (
    input.subscribe &&
    (!account.webhookExternalId || resubscribe) &&
    provider.subscribeWebhooks
  ) {
    try {
      await subscribeAccount(ctx, account, credential);
    } catch (error) {
      // Not fatal: the account still publishes, and comments still arrive by
      // the sweep. The next pass tries again.
      logger.warn('could not subscribe an account to webhooks', {
        socialAccountId: account.id,
        platform: account.platform,
        reason: (error as { code?: string }).code ?? 'unknown',
      });
    }
  }

  if (!messaging.supported || !provider.fetchConversations) {
    return { kind: 'SKIPPED', reason: 'UNSUPPORTED' };
  }

  // An account connected before messaging was on holds none of these, and the
  // platform would refuse every call. The inbox tells people to reconnect.
  if (!messaging.scopes.every((scope) => credential.scopes.includes(scope))) {
    return { kind: 'SKIPPED', reason: 'MISSING_SCOPES' };
  }

  const newest = await withTenant(ctx, (db) =>
    db.socialConversation.findFirst({
      where: { socialAccountId },
      select: { lastMessageAt: true },
      orderBy: { lastMessageAt: 'desc' },
    }),
  );
  const since = newest
    ? new Date(newest.lastMessageAt.getTime() - SYNC_OVERLAP_MS)
    : new Date(clock.now().getTime() - FIRST_SYNC_LOOKBACK_MS);

  const page = await provider.fetchConversations({
    credential,
    account: { externalId: account.externalId },
    since,
    ...(cursor ? { cursor } : {}),
  });

  let created = 0;
  for (const conversation of page.conversations) {
    for (const message of conversation.messages) {
      const recorded = await withTenant(ctx, (db) =>
        recordMessage(db, ctx, account, message, {
          participant: conversation.participant,
          externalThreadId: conversation.externalId,
        }),
      );
      if (recorded.created) created += 1;
    }
  }

  return {
    kind: 'SYNCED',
    conversations: page.conversations.length,
    created,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

/**
 * Subscribe an account to webhooks and remember the id they will name it by.
 *
 * Stored even when it is the account's own id, because a non-null value is
 * also the record that the subscription was made — without it every sync would
 * subscribe again.
 */
export async function subscribeAccount(
  ctx: TenantContext,
  account: Pick<AccountRow, 'id' | 'platform' | 'externalId'>,
  credential: Awaited<ReturnType<typeof loadAccountCredential>>,
): Promise<void> {
  const provider = getProvider(account.platform);
  if (!provider.subscribeWebhooks) return;

  const result = await provider.subscribeWebhooks({
    credential,
    account: { externalId: account.externalId },
  });

  await withTenant(ctx, (db) =>
    db.socialAccount.update({
      where: { id: account.id },
      data: { webhookExternalId: result.webhookExternalId ?? account.externalId },
    }),
  );

  logger.info('social account subscribed to webhooks', {
    socialAccountId: account.id,
    platform: account.platform,
  });
}
