import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  accessibleWorkspaceIds,
  actorUserId,
  clock,
  isUserPrincipal,
  replyWindow,
  type Platform,
  type ReplyWindow,
  type TenantContext,
} from '@orbit/core';
import { withTenant } from '@orbit/db';
import { logger } from '@orbit/observability';
import { capabilitiesFor, getProvider, isSupported } from '@orbit/providers';
import { assertCan, canSomewhere } from '@orbit/rbac';
import { audit, type AuditInput } from '@/server/audit';
import { loadCredential } from '@/features/social/service';
import type { ConversationAssignInput, MessageReplyInput } from './contracts';

/**
 * Private messages: the inbox's second half (**D-107**).
 *
 * Built on the same rules as the comment inbox, for the same reasons — see
 * `features/community/service.ts`:
 *
 * - **Authorization per row.** `message:read` and `message:reply` are
 *   brand-scoped for a Content Creator and an Approver, so every write
 *   resolves its conversation and checks against *that* row's workspace and
 *   brand. Reads gate on `canSomewhere` and narrow the query to the
 *   principal's workspaces rather than filtering what was read.
 * - **The platform first, then the row.** A reply is recorded only once the
 *   platform has confirmed it with an id.
 *
 * And one rule comments do not have: **the brand may only answer.** A reply
 * is legal only inside the window the person's latest message opened, which
 * is checked here, before the call — with the deadline shown to the person
 * typing, so nobody writes a careful answer to a conversation that has closed.
 */

const LIST_LIMIT = 100;
const THREAD_LIMIT = 200;

/** Platforms that have private messages at all. */
const MESSAGING_PLATFORMS: readonly Platform[] = ['FACEBOOK', 'INSTAGRAM'];

/**
 * Whether this deployment offers private messages anywhere.
 *
 * Read from the descriptors rather than the environment flag, so the inbox
 * agrees with what the adapters will actually do. Instagram is asked about its
 * username-login surface, which is the only one that carries messaging.
 */
export function messagingAvailable(): boolean {
  return MESSAGING_PLATFORMS.some(
    (platform) =>
      isSupported(platform) &&
      capabilitiesFor(platform, platform === 'INSTAGRAM' ? 'INSTAGRAM_LOGIN' : null).messaging
        .supported,
  );
}

const CONVERSATION_SELECT = {
  id: true,
  workspaceId: true,
  brandId: true,
  socialAccountId: true,
  participantName: true,
  participantUsername: true,
  lastMessageAt: true,
  lastInboundAt: true,
  state: true,
  assignedToId: true,
  handledAt: true,
  assignedTo: { select: { id: true, name: true, email: true } },
  socialAccount: {
    select: {
      id: true,
      displayName: true,
      handle: true,
      avatarUrl: true,
      platform: true,
      accountType: true,
      scopes: true,
    },
  },
} as const;

const MESSAGE_SELECT = {
  id: true,
  direction: true,
  text: true,
  attachments: true,
  sentAt: true,
  deletedAt: true,
  createdBy: { select: { id: true, name: true } },
} as const;

/** The read gate. Guards nothing on its own; the query narrowing confines it. */
function assertReadable(ctx: TenantContext): void {
  if (!canSomewhere(ctx, 'message:read')) {
    throw new ForbiddenError('Permission denied: message:read', {
      userMessage: 'You do not have access to messages.',
      context: { permission: 'message:read' },
    });
  }
}

/**
 * The inbox: conversations waiting on somebody first, then the most recent.
 *
 * With the last message of each, for the preview line — one extra relation
 * read per row rather than a second query.
 */
export async function listConversations(ctx: TenantContext, query: { waitingOnly?: boolean } = {}) {
  assertReadable(ctx);
  const accessible = accessibleWorkspaceIds(ctx);

  const rows = await withTenant(ctx, (db) =>
    db.socialConversation.findMany({
      where: {
        ...(accessible === 'ALL' ? {} : { workspaceId: { in: [...accessible] } }),
        ...(query.waitingOnly ? { state: 'NEW' as const } : {}),
        socialAccount: { deletedAt: null },
      },
      select: {
        ...CONVERSATION_SELECT,
        messages: {
          select: { direction: true, text: true, attachments: true, deletedAt: true },
          orderBy: { sentAt: 'desc' },
          take: 1,
        },
      },
      orderBy: [{ state: 'asc' }, { lastMessageAt: 'desc' }],
      take: LIST_LIMIT,
    }),
  );

  const now = clock.now();
  return rows.map(({ messages, ...conversation }) => ({
    ...conversation,
    lastMessage: messages[0] ?? null,
    window: windowFor(conversation, now),
  }));
}

export type InboxConversation = Awaited<ReturnType<typeof listConversations>>[number];

/** How many conversations are waiting — the number beside the tab. */
export async function waitingConversationCount(ctx: TenantContext): Promise<number> {
  assertReadable(ctx);
  const accessible = accessibleWorkspaceIds(ctx);

  return withTenant(ctx, (db) =>
    db.socialConversation.count({
      where: {
        state: 'NEW',
        socialAccount: { deletedAt: null },
        ...(accessible === 'ALL' ? {} : { workspaceId: { in: [...accessible] } }),
      },
    }),
  );
}

/**
 * One conversation and its most recent messages, oldest first.
 *
 * With what the composer needs to know before anybody types: whether a reply
 * may be sent now, until when, and whether the connection can send at all.
 */
export async function getConversation(ctx: TenantContext, conversationId: string) {
  const conversation = await requireConversation(ctx, conversationId, 'message:read');

  const messages = await withTenant(ctx, (db) =>
    db.socialMessage.findMany({
      where: { conversationId },
      select: MESSAGE_SELECT,
      orderBy: { sentAt: 'desc' },
      take: THREAD_LIMIT,
    }),
  );

  return {
    conversation,
    // Read newest-first to bound it, shown oldest-first to read it.
    messages: messages.reverse(),
    window: windowFor(conversation, clock.now()),
    needsReconnect: missingScopes(conversation).length > 0,
    maxMessageLength: messagingOf(conversation).maxMessageLength ?? null,
  };
}

/**
 * Answer the person, as the brand.
 *
 * In this order: authorize against the conversation's own brand, check the
 * platform can, check the length, check the window, check the connection holds
 * the scopes — then send, and only then write. Every refusal before the send
 * says what to do about it.
 */
export async function replyToConversation(
  ctx: TenantContext,
  conversationId: string,
  input: MessageReplyInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const conversation = await requireConversation(ctx, conversationId, 'message:reply');
  const account = conversation.socialAccount;
  const messaging = messagingOf(conversation);
  const provider = getProvider(account.platform);

  if (!messaging.supported || !provider.sendMessage) {
    throw new ConflictError('Messaging is not available here', {
      userMessage: `Replying to messages is not available for ${account.displayName}.`,
    });
  }

  if (messaging.maxMessageLength && input.text.length > messaging.maxMessageLength) {
    throw new ConflictError('Message is too long', {
      userMessage: `This platform allows ${messaging.maxMessageLength.toLocaleString()} characters in a message.`,
    });
  }
  if (
    messaging.maxMessageBytes &&
    Buffer.byteLength(input.text, 'utf8') > messaging.maxMessageBytes
  ) {
    // Instagram counts bytes, and a Vietnamese letter is two or three of them,
    // so a reply under the character limit can still be over this one.
    throw new ConflictError('Message is too long', {
      userMessage: 'This message is too long for Instagram. Shorten it and try again.',
    });
  }

  const now = clock.now();
  const window = windowFor(conversation, now);
  if (window.state === 'CLOSED') {
    throw new ConflictError('The reply window has closed', {
      userMessage: messaging.humanAgentWindowHours
        ? 'It has been more than 7 days since this person last wrote, so the platform no longer allows a reply. You can answer once they message again.'
        : 'It has been more than 24 hours since this person last wrote, so the platform no longer allows a reply. You can answer once they message again.',
    });
  }

  const missing = missingScopes(conversation);
  if (missing.length > 0) {
    throw new ConflictError('The connection cannot send messages', {
      userMessage: `${account.displayName} needs to be reconnected before the team can reply to messages from Orbit.`,
      context: { missingScopes: missing },
    });
  }

  // The two platform ids, read only here, at the moment they are used.
  const addressing = await withTenant(ctx, (db) =>
    db.socialConversation.findFirst({
      where: { id: conversationId },
      select: { participantExternalId: true, socialAccount: { select: { externalId: true } } },
    }),
  );
  if (!addressing) throw new NotFoundError('Conversation');

  const credential = await loadCredential(ctx, account.id);

  const sent = await provider.sendMessage({
    credential,
    account: { externalId: addressing.socialAccount.externalId },
    recipientExternalId: addressing.participantExternalId,
    text: input.text,
    humanAgent: window.state === 'HUMAN_AGENT',
  });

  const message = await withTenant(ctx, async (db) => {
    const created = await db.socialMessage.create({
      data: {
        organizationId: ctx.organizationId,
        conversationId,
        socialAccountId: account.id,
        // The platform's id, so the echo webhook recognises this as already here.
        externalId: sent.externalId,
        direction: 'OUTBOUND',
        text: input.text,
        sentAt: sent.sentAt,
        ...(actorUserId(ctx) ? { createdById: actorUserId(ctx) as string } : {}),
      },
      select: MESSAGE_SELECT,
    });

    // Answering is handling, in the same transaction, so the inbox cannot show
    // an answered conversation as still waiting.
    await db.socialConversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: sent.sentAt,
        state: 'HANDLED',
        handledAt: now,
        ...(actorUserId(ctx) ? { handledById: actorUserId(ctx) as string } : {}),
      },
    });

    await audit(db, ctx, {
      action: 'social_message.sent',
      resourceType: 'SocialConversation',
      resourceId: conversationId,
      workspaceId: conversation.workspaceId,
      brandId: conversation.brandId,
      // That it happened and how, never the words: the row holds those, and
      // the audit log is kept for longer than a message is.
      after: { messageId: created.id, humanAgent: window.state === 'HUMAN_AGENT' },
      ...fingerprint,
    });

    return created;
  });

  logger.info('replied to a private message', {
    conversationId,
    platform: account.platform,
    socialAccountId: account.id,
    humanAgent: window.state === 'HUMAN_AGENT',
  });

  return message;
}

/** Mark a conversation dealt with, or put it back. */
export async function setConversationHandled(
  ctx: TenantContext,
  conversationId: string,
  handled: boolean,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const conversation = await requireConversation(ctx, conversationId, 'message:reply');

  return withTenant(ctx, async (db) => {
    const updated = await db.socialConversation.update({
      where: { id: conversationId },
      data: handled
        ? {
            state: 'HANDLED',
            handledAt: clock.now(),
            ...(actorUserId(ctx) ? { handledById: actorUserId(ctx) as string } : {}),
          }
        : { state: 'NEW', handledAt: null, handledById: null },
      select: CONVERSATION_SELECT,
    });

    await audit(db, ctx, {
      action: handled ? 'social_conversation.handled' : 'social_conversation.reopened',
      resourceType: 'SocialConversation',
      resourceId: conversationId,
      workspaceId: conversation.workspaceId,
      brandId: conversation.brandId,
      ...fingerprint,
    });

    return updated;
  });
}

/**
 * Hand a conversation to a colleague.
 *
 * The assignee is checked to be an active, non-client member of this
 * organization: the id comes from a browser, and `User` spans organizations.
 */
export async function assignConversation(
  ctx: TenantContext,
  conversationId: string,
  input: ConversationAssignInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const conversation = await requireConversation(ctx, conversationId, 'message:reply');

  return withTenant(ctx, async (db) => {
    if (input.assignedToId) {
      const member = await db.organizationMembership.findFirst({
        where: { userId: input.assignedToId, status: 'ACTIVE' },
        select: { role: true },
      });

      if (!member) throw new NotFoundError('Member');
      if (member.role === 'CLIENT') {
        throw new ConflictError('A client cannot be assigned a conversation', {
          userMessage: 'That person is a client. Conversations can only be assigned to the team.',
        });
      }
    }

    const updated = await db.socialConversation.update({
      where: { id: conversationId },
      data: { assignedToId: input.assignedToId },
      select: CONVERSATION_SELECT,
    });

    await audit(db, ctx, {
      action: 'social_conversation.assigned',
      resourceType: 'SocialConversation',
      resourceId: conversationId,
      workspaceId: conversation.workspaceId,
      brandId: conversation.brandId,
      before: { assignedToId: conversation.assignedToId },
      after: { assignedToId: input.assignedToId },
      ...fingerprint,
    });

    return updated;
  });
}

// ── Internals ───────────────────────────────────────────────────────────────

type ConversationRow = {
  lastInboundAt: Date | null;
  socialAccount: { platform: Platform; accountType: string | null; scopes: string[] };
};

function messagingOf(conversation: ConversationRow) {
  return capabilitiesFor(
    conversation.socialAccount.platform,
    conversation.socialAccount.accountType,
  ).messaging;
}

function windowFor(conversation: ConversationRow, now: Date): ReplyWindow {
  const messaging = messagingOf(conversation);
  if (!messaging.supported || messaging.replyWindowHours === undefined) {
    return { state: 'CLOSED', closesAt: null };
  }
  return replyWindow({
    lastInboundAt: conversation.lastInboundAt,
    now,
    rules: {
      standardHours: messaging.replyWindowHours,
      humanAgentHours: messaging.humanAgentWindowHours,
    },
  });
}

/**
 * Scopes the platform needs that this connection does not hold.
 *
 * From the account row's own copy of its scopes, so the composer can say
 * "reconnect" without decrypting a credential to find out.
 */
function missingScopes(conversation: ConversationRow): string[] {
  const messaging = messagingOf(conversation);
  return messaging.scopes.filter((scope) => !conversation.socialAccount.scopes.includes(scope));
}

/**
 * Load a conversation and authorize against *its* workspace and brand.
 *
 * Not found for another tenant's conversation, which the scoped client cannot
 * see anyway, so a probe learns nothing. The person's platform id is not part
 * of what is returned: only the reply path reads it, at the moment it is used.
 */
async function requireConversation(
  ctx: TenantContext,
  conversationId: string,
  permission: 'message:read' | 'message:reply',
) {
  if (!isUserPrincipal(ctx.principal)) {
    throw new ForbiddenError('Messages need a signed-in user', {
      userMessage: 'This action needs a signed-in user.',
      context: { actor: ctx.principal.actorName },
    });
  }

  const conversation = await withTenant(ctx, (db) =>
    db.socialConversation.findFirst({
      where: { id: conversationId, socialAccount: { deletedAt: null } },
      select: CONVERSATION_SELECT,
    }),
  );

  if (!conversation) throw new NotFoundError('Conversation');

  assertCan(ctx, permission, {
    workspaceId: conversation.workspaceId,
    brandId: conversation.brandId,
  });

  return conversation;
}
