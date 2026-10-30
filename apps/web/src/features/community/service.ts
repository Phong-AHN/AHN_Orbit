import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  accessibleWorkspaceIds,
  actorUserId,
  clock,
  isUserPrincipal,
  type TenantContext,
} from '@orbit/core';
import { withTenant } from '@orbit/db';
import { enqueue, takeToken } from '@orbit/queue';
import { assertAgentConfirmed, assertCan, canSomewhere } from '@orbit/rbac';
import { logger } from '@orbit/observability';
import { capabilitiesFor, getProvider } from '@orbit/providers';
import { audit, type AuditInput } from '@/server/audit';
import { ensureProvidersRegistered } from '@/server/providers';
import { loadCredential } from '@/features/social/service';
import type { AssignInput, CommentQuery, ReplyInput } from './contracts';
import { comparePosts, summariesFromGroups, type PostSummary } from './thread';

/**
 * The community inbox (SRS §22).
 *
 * What the audience said on posts Orbit published, and what the agency said
 * back. The queue this serves is the one thing Buffer does that Orbit could
 * not: before this there was no way to see an audience comment at all, let
 * alone answer one.
 *
 * ## Authorization is per row, not per request
 *
 * `comment:read_public` and `comment:reply` are **brand-scoped** for a Content
 * Creator and an Approver, so a request cannot be authorized once and then
 * allowed to range over the organization. Every write resolves its row first
 * and checks the permission against *that row's* workspace and brand.
 *
 * Reads cannot work that way — there is no row yet — so they do two things
 * instead:
 *
 * 1. **`canSomewhere` for the gate.** Asking `can` with an empty resource
 *    denies a brand-scoped grant outright, which would lock out exactly the
 *    Content Creators and Approvers the queue is for. This is the same trap
 *    that denied the setup guide its audience in **D-098**, and it caught this
 *    file too: the first version asserted `can(ctx, 'comment:read_public', {})`
 *    and an integration test with a seeded Approver is what failed.
 * 2. **Narrowing the query, not filtering the result.** `accessibleWorkspaceIds`
 *    restricts the `where` clause, so rows outside this principal's workspaces
 *    are never fetched. A filter applied afterwards is a decision made once the
 *    data has already been read, and the read is the thing that has to be
 *    scoped.
 *
 * Workspace narrowing is sufficient rather than a shortcut, and the policy
 * engine is why: a `BrandAssignment` can only ever *narrow* access within a
 * workspace, and a brand with no assignment falls back to workspace membership
 * (see `policy.ts`). Neither of these two permissions carries
 * `requiresApprovalRight`, which is the only thing an assignment could further
 * restrict here.
 *
 * ## Replying is publishing
 *
 * A reply puts words on a client's channel under the client's name, in public,
 * with no approval gate in front of it. So it is audited, it requires a
 * permission an Approver does not hold, and it is recorded only after the
 * platform confirms it.
 */

const DEFAULT_LIMIT = 50;

/** The row shape the queue renders. No credential, no platform author id. */
const COMMENT_SELECT = {
  id: true,
  workspaceId: true,
  brandId: true,
  socialAccountId: true,
  postVariantId: true,
  externalId: true,
  parentExternalId: true,
  origin: true,
  authorName: true,
  message: true,
  permalink: true,
  postedAt: true,
  state: true,
  assignedToId: true,
  handledAt: true,
  createdAt: true,
  assignedTo: { select: { id: true, name: true, email: true } },
  // `accountType` is selected for the capability lookup, not for display: on
  // Instagram the reply scope's *name* depends on which connection flow the
  // account used, so a descriptor resolved without it names the wrong scope
  // and refuses every reply as "needs reconnecting".
  socialAccount: {
    select: { id: true, displayName: true, platform: true, accountType: true },
  },
  postVariant: {
    select: {
      id: true,
      externalPermalink: true,
      post: { select: { id: true, title: true } },
    },
  },
} as const;

export type CommunityComment = Awaited<ReturnType<typeof listComments>>[number];

/**
 * The queue.
 *
 * Defaults to the public's comments only. Our own replies are in the same table
 * and matter for reading a thread, but a queue of things needing attention that
 * includes the agency's own answers is a queue nobody trusts.
 */
export async function listComments(ctx: TenantContext, query: CommentQuery = {}) {
  assertReadable(ctx);
  const accessible = accessibleWorkspaceIds(ctx);

  return withTenant(ctx, (db) =>
    db.socialComment.findMany({
      where: {
        // The principal's own reach first, so a narrower filter can only ever
        // narrow further — a `workspaceId` in the query cannot widen it.
        ...(accessible === 'ALL' ? {} : { workspaceId: { in: [...accessible] } }),
        ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
        ...(query.brandId ? { brandId: query.brandId } : {}),
        ...(query.socialAccountId ? { socialAccountId: query.socialAccountId } : {}),
        ...(query.state ? { state: query.state } : {}),
        ...(query.includeOurs ? {} : { origin: 'AUDIENCE' as const }),
        ...(query.before ? { postedAt: { lt: query.before } } : {}),
        // A comment on a soft-deleted post is not part of anybody's queue.
        postVariant: { deletedAt: null },
      },
      select: COMMENT_SELECT,
      orderBy: { postedAt: 'desc' },
      take: Math.min(query.limit ?? DEFAULT_LIMIT, 100),
    }),
  );
}

/**
 * The inbox as a list of **posts**, each with how much its audience said.
 *
 * Comments belong to a post, and both platforms present them that way: you
 * open a post and read what people said under it. A flat queue of comments
 * from every post at once loses the one thing that makes a comment readable —
 * what it was a reply *to*.
 *
 * ## Counted with a grouped query
 *
 * A post's numbers come from `groupBy(['postVariantId', 'origin', 'state'])`,
 * so the cost is at most four rows per post however many comments it has.
 * `summariesFromGroups` turns those into the same `PostSummary` the thread view
 * computes from rows, and a test holds the two to the same answer.
 *
 * ## Authorization is the queue’s, unchanged
 *
 * Narrowed to the principal’s reachable workspaces before anything is
 * counted, exactly as `listComments` is — so a brand-scoped role never sees
 * a count for a post it could not open.
 */
export async function listCommentedPosts(
  ctx: TenantContext,
  query: { waitingOnly?: boolean } = {},
) {
  assertReadable(ctx);
  const accessible = accessibleWorkspaceIds(ctx);
  const scope = accessible === 'ALL' ? {} : { workspaceId: { in: [...accessible] } };

  const groups = await withTenant(ctx, (db) =>
    db.socialComment.groupBy({
      by: ['postVariantId', 'origin', 'state'],
      where: scope,
      _count: { _all: true },
      _max: { postedAt: true },
    }),
  );

  const summaries = summariesFromGroups(
    groups.map((group) => ({
      postVariantId: group.postVariantId,
      origin: group.origin,
      state: group.state,
      count: group._count._all,
      latestAt: group._max.postedAt,
    })),
  );

  const ids = [...summaries.keys()];
  if (ids.length === 0) return [];

  const variants = await withTenant(ctx, (db) =>
    db.postVariant.findMany({
      // Deleted posts drop out here rather than in the grouped query, because
      // a relation filter there is not something the tenant scope is known to
      // narrow correctly.
      where: { id: { in: ids }, deletedAt: null },
      select: POST_CARD_SELECT,
    }),
  );

  const cards = variants
    .map((variant) => ({ ...variant, summary: summaries.get(variant.id) as PostSummary }))
    .filter((card) => card.summary.audience > 0)
    .filter((card) => !query.waitingOnly || card.summary.needsReply > 0);

  return cards.sort((a, b) => comparePosts(a.summary, b.summary));
}

export type CommentedPost = Awaited<ReturnType<typeof listCommentedPosts>>[number];

/**
 * One post and every comment on it — the audience’s and the agency’s.
 *
 * Both are returned, because a thread without our own replies is not the thread
 * the public is looking at.
 *
 * Authorized against the post’s own workspace and brand, with the same
 * `assertCan` `requireComment` uses for a single comment: opening a post is
 * reading every comment on it, so it must be refused wherever reading one of
 * them would be.
 */
export async function getPostThread(ctx: TenantContext, postVariantId: string) {
  assertReadable(ctx);

  const variant = await withTenant(ctx, (db) =>
    db.postVariant.findFirst({
      where: { id: postVariantId, deletedAt: null },
      select: {
        ...POST_CARD_SELECT,
        post: {
          select: {
            id: true,
            title: true,
            workspaceId: true,
            brandId: true,
            media: {
              // Media attached to this variant, or to the whole post.
              where: { OR: [{ postVariantId }, { postVariantId: null }] },
              orderBy: { position: 'asc' },
              select: {
                altText: true,
                mediaAsset: {
                  select: {
                    id: true,
                    kind: true,
                    mimeType: true,
                    width: true,
                    height: true,
                    durationMs: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
  );

  if (!variant) throw new NotFoundError('Post');

  assertCan(ctx, 'comment:read_public', {
    workspaceId: variant.post.workspaceId,
    brandId: variant.post.brandId,
  });

  const comments = await withTenant(ctx, (db) =>
    db.socialComment.findMany({
      where: { postVariantId },
      select: COMMENT_SELECT,
      orderBy: { postedAt: 'asc' },
    }),
  );

  return { variant, comments };
}

/** What a post card and the thread header both need. */
const POST_CARD_SELECT = {
  id: true,
  platform: true,
  body: true,
  hashtags: true,
  publishedAt: true,
  externalPermalink: true,
  socialAccount: {
    select: { id: true, displayName: true, handle: true, avatarUrl: true, platform: true },
  },
  post: { select: { id: true, title: true } },
} as const;

/** How many still need somebody — the number the sidebar shows. */
export async function unhandledCount(ctx: TenantContext): Promise<number> {
  assertReadable(ctx);
  const accessible = accessibleWorkspaceIds(ctx);

  return withTenant(ctx, (db) =>
    db.socialComment.count({
      where: {
        state: 'NEW',
        origin: 'AUDIENCE',
        postVariant: { deletedAt: null },
        // Narrowed identically to the list, or the count would promise work
        // that the queue then does not show.
        ...(accessible === 'ALL' ? {} : { workspaceId: { in: [...accessible] } }),
      },
    }),
  );
}

/**
 * The read gate: is the inbox part of this principal's product at all?
 *
 * `canSomewhere` rather than `can` for the reason in this file's docstring —
 * a brand-scoped grant asked with no resource denies. This guards nothing on
 * its own; the query narrowing is what confines the answer, and every write
 * re-checks against its own row.
 */
function assertReadable(ctx: TenantContext): void {
  if (!canSomewhere(ctx, 'comment:read_public')) {
    throw new ForbiddenError('Permission denied: comment:read_public', {
      userMessage: 'You do not have access to the community inbox.',
      context: { permission: 'comment:read_public' },
    });
  }
}

/**
 * One thread: the comment, and everything hanging off it including our replies.
 *
 * Threaded on `parentExternalId` — the platform's own structure — rather than a
 * self-referencing foreign key of ours. The platform already decided what
 * replies to what, and a second answer to that question is one that can
 * disagree with the post the public is actually looking at.
 */
export async function getThread(ctx: TenantContext, commentId: string) {
  const root = await requireComment(ctx, commentId, 'comment:read_public');

  const replies = await withTenant(ctx, (db) =>
    db.socialComment.findMany({
      where: { parentExternalId: root.externalId, socialAccountId: root.socialAccountId },
      select: COMMENT_SELECT,
      orderBy: { postedAt: 'asc' },
    }),
  );

  return { root, replies };
}

/**
 * Answer a comment, as the brand, in public.
 *
 * ## The order of operations, and why
 *
 * The platform call happens **before** the write, and the row is created only
 * once the platform has returned an id. The opposite order would record a reply
 * that might not exist, which is worse here than in most places: the queue
 * would show the comment answered, nobody would look at it again, and the
 * client's customer would still be waiting.
 *
 * If the platform succeeds and our write then fails, the reply exists publicly
 * and we have no record of it. That is the one failure this cannot fully
 * prevent, and it self-heals: ingestion sees the reply on the next pass, marks
 * it `ours`, and the thread becomes complete. The comment stays `NEW` until
 * then, so the worst case is somebody reading a thread that already contains
 * the answer — which is visible, rather than a silent gap.
 */
export async function replyToComment(
  ctx: TenantContext,
  commentId: string,
  input: ReplyInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  // An agent sends only what its user confirmed (D-109 §5).
  assertAgentConfirmed(ctx, 'comment:reply');
  const comment = await requireComment(ctx, commentId, 'comment:reply');

  if (comment.origin === 'ORBIT') {
    throw new ConflictError('That is our own reply', {
      userMessage: 'This is a reply the team already sent. Answer the original comment instead.',
    });
  }

  // The registry is per process, and a cold serverless instance has an empty
  // one: without this, a route reached before any page had registered the
  // adapters answered "Facebook isn't available yet" (2026-10-29).
  ensureProvidersRegistered();
  const provider = getProvider(comment.socialAccount.platform);
  const engagement = capabilitiesFor(
    comment.socialAccount.platform,
    comment.socialAccount.accountType,
  ).engagement;

  // Checked against the descriptor rather than assumed from the platform name:
  // the whole point of the capability layer is that no caller outside the
  // provider directory knows which platforms can do what.
  if (!engagement.reply || !provider.replyToComment) {
    throw new ConflictError('Replying is not supported here', {
      userMessage: `Replying to comments is not available for ${comment.socialAccount.platform.toLowerCase()} yet.`,
    });
  }

  if (engagement.maxReplyLength && input.message.length > engagement.maxReplyLength) {
    throw new ConflictError('Reply is too long', {
      userMessage: `This platform allows ${engagement.maxReplyLength.toLocaleString()} characters in a reply.`,
      context: { length: input.message.length, maxReplyLength: engagement.maxReplyLength },
    });
  }

  const credential = await loadCredential(ctx, comment.socialAccountId);

  // A scope that was never granted is a better error before the call than
  // after it: an account connected before community management shipped holds
  // the read scope and not the reply scope.
  const missing = engagement.replyScopes.filter(
    (scope: string) => !credential.scopes.includes(scope),
  );
  if (missing.length > 0) {
    throw new ConflictError('The connection cannot reply', {
      userMessage: `${comment.socialAccount.displayName} needs to be reconnected before the team can reply from Social Square.`,
      context: { missingScopes: missing },
    });
  }

  const sent = await provider.replyToComment({
    commentExternalId: comment.externalId,
    message: input.message,
    credential,
  });

  const reply = await withTenant(ctx, async (db) => {
    const created = await db.socialComment.create({
      data: {
        organizationId: ctx.organizationId,
        workspaceId: comment.workspaceId,
        brandId: comment.brandId,
        socialAccountId: comment.socialAccountId,
        postVariantId: comment.postVariantId,
        externalId: sent.externalId,
        // The platform's own threading, so ingestion and the UI agree.
        parentExternalId: comment.externalId,
        origin: 'ORBIT',
        message: input.message,
        ...(sent.permalink ? { permalink: sent.permalink } : {}),
        postedAt: sent.postedAt ?? clock.now(),
        // Our own reply is not a thing needing attention.
        state: 'HANDLED',
        handledAt: clock.now(),
        ...(actorUserId(ctx) ? { handledById: actorUserId(ctx) as string } : {}),
        ...(actorUserId(ctx) ? { createdById: actorUserId(ctx) as string } : {}),
      },
      select: COMMENT_SELECT,
    });

    // Answering is handling. Done in the same transaction so the queue cannot
    // show an answered comment as still waiting.
    await db.socialComment.update({
      where: { id: comment.id },
      data: {
        state: 'HANDLED',
        handledAt: clock.now(),
        ...(actorUserId(ctx) ? { handledById: actorUserId(ctx) as string } : {}),
      },
    });

    await audit(db, ctx, {
      action: 'social_comment.replied',
      resourceType: 'SocialComment',
      resourceId: comment.id,
      workspaceId: comment.workspaceId,
      brandId: comment.brandId,
      // The reply's text is in the row; the audit records that it happened and
      // to what, not a second copy of the words.
      after: { replyId: created.id, externalId: sent.externalId },
      ...fingerprint,
    });

    return created;
  });

  logger.info('replied to an audience comment', {
    commentId: comment.id,
    replyId: reply.id,
    platform: comment.socialAccount.platform,
    socialAccountId: comment.socialAccountId,
  });

  return reply;
}

/**
 * Read the connected accounts now, instead of waiting for the sweep.
 *
 * ## Why this exists
 *
 * The queue is filled by a worker sweep — every 15 minutes for a post under
 * two days old, every two hours after that. That cadence is right for the
 * steady state and wrong for two cases a person actually hits: somebody has
 * just been told by a client that a comment needs answering, and somebody is
 * demonstrating the product. An inbox with no way to say "check now" is an
 * inbox people refresh by reloading the page and then distrust.
 *
 * ## Why it is rate limited, and hard
 *
 * **Meta's rate limit is per app, not per tenant.** Every call one agency makes
 * is quota no other agency gets, which makes an unbounded refresh button a way
 * for one organization to degrade every other organization on the platform.
 * The cooldown is therefore not politeness about server load — it is the only
 * thing standing between a double-bound button and an app-wide quota outage.
 *
 * One token per organization per minute. Generous for the human case: a person
 * checking an inbox presses this once and reads the result. A script presses it
 * in a loop, and is refused on the second press.
 *
 * ## What it does not do
 *
 * It does not read comments itself. It enqueues the same `engagement` job the
 * sweep enqueues, so there is exactly one ingestion path and no second place
 * where a comment could be written differently. The job is asynchronous, so
 * this returns how many accounts were queued rather than how many comments
 * arrived — claiming a count here would mean lying about work not yet done.
 */
export async function syncNow(ctx: TenantContext, correlationId: string) {
  // Same authorization shape as `listComments`: `comment:read_public` is
  // brand-scoped for a Content Creator and an Approver, so asserting it with an
  // empty resource scope would deny the very people the queue is for (D-069).
  assertReadable(ctx);

  const limit = await takeToken(`ratelimit:community-sync:org:${ctx.organizationId}`, {
    capacity: 1,
    refillWindowMs: 60_000,
  });

  if (!limit.allowed) {
    throw new RateLimitedError('Community sync is rate limited', {
      retryAfterSeconds: Math.ceil(limit.retryAfterMs / 1_000),
      userMessage: 'The inbox was just refreshed. Try again in a moment.',
    });
  }

  const scope = accessibleWorkspaceIds(ctx);

  // Only accounts the caller can actually reach. A brand-scoped role refreshing
  // the inbox must not cause a read of an account outside its brands — that
  // would spend the tenant's quota on data the caller may not see.
  const accounts = await withTenant(ctx, (db) =>
    db.socialAccount.findMany({
      where: {
        status: 'ACTIVE',
        ...(scope === 'ALL' ? {} : { workspaceId: { in: [...scope] } }),
      },
      select: { id: true, platform: true },
      // A bound, so one organization with hundreds of accounts cannot turn one
      // press into hundreds of jobs.
      take: 50,
    }),
  );

  for (const account of accounts) {
    await enqueue('engagement', {
      organizationId: ctx.organizationId,
      correlationId,
      socialAccountId: account.id,
    });

    // Private messages too, on the platforms that have them (D-107). The job
    // reads nothing when messaging is switched off, so this costs no quota
    // where there is nothing to read.
    if (account.platform === 'FACEBOOK' || account.platform === 'INSTAGRAM') {
      await enqueue('messaging', {
        organizationId: ctx.organizationId,
        correlationId,
        socialAccountId: account.id,
      });
    }
  }

  logger.info('community inbox sync requested', {
    organizationId: ctx.organizationId,
    accounts: accounts.length,
    correlationId,
  });

  return { queued: accounts.length };
}

/** Mark a comment dealt with, or put it back in the queue. */
export async function setHandled(
  ctx: TenantContext,
  commentId: string,
  handled: boolean,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const comment = await requireComment(ctx, commentId, 'comment:reply');

  return withTenant(ctx, async (db) => {
    const updated = await db.socialComment.update({
      where: { id: comment.id },
      data: handled
        ? {
            state: 'HANDLED',
            handledAt: clock.now(),
            ...(actorUserId(ctx) ? { handledById: actorUserId(ctx) as string } : {}),
          }
        : // Reopening clears both, because the check constraint requires a NEW
          // row to carry neither — half a record of who handled it is worse
          // than none.
          { state: 'NEW', handledAt: null, handledById: null },
      select: COMMENT_SELECT,
    });

    await audit(db, ctx, {
      action: handled ? 'social_comment.handled' : 'social_comment.reopened',
      resourceType: 'SocialComment',
      resourceId: comment.id,
      workspaceId: comment.workspaceId,
      brandId: comment.brandId,
      ...fingerprint,
    });

    return updated;
  });
}

/**
 * Hand a comment to somebody.
 *
 * The assignee must be a member of this organization, checked rather than
 * trusted: the id arrives from a browser, and a foreign key to `User` alone
 * would happily accept somebody from another tenant — `User` spans
 * organizations, so it is the one reference that cannot be made composite.
 */
export async function assignComment(
  ctx: TenantContext,
  commentId: string,
  input: AssignInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const comment = await requireComment(ctx, commentId, 'comment:reply');

  return withTenant(ctx, async (db) => {
    if (input.assignedToId) {
      const member = await db.organizationMembership.findFirst({
        where: { userId: input.assignedToId, status: 'ACTIVE' },
        select: { role: true },
      });

      // 404 rather than 403, the same answer as for a user who does not exist,
      // so this cannot be used to discover who belongs to another tenant.
      if (!member) throw new NotFoundError('Member');

      // A client cannot be handed the agency's community management. They have
      // no access to this surface at all, so an assignment to one would be a
      // task nobody could ever see.
      if (member.role === 'CLIENT') {
        throw new ConflictError('A client cannot be assigned a comment', {
          userMessage: 'That person is a client. Comments can only be assigned to the team.',
        });
      }
    }

    const updated = await db.socialComment.update({
      where: { id: comment.id },
      data: { assignedToId: input.assignedToId },
      select: COMMENT_SELECT,
    });

    await audit(db, ctx, {
      action: 'social_comment.assigned',
      resourceType: 'SocialComment',
      resourceId: comment.id,
      workspaceId: comment.workspaceId,
      brandId: comment.brandId,
      before: { assignedToId: comment.assignedToId },
      after: { assignedToId: input.assignedToId },
      ...fingerprint,
    });

    return updated;
  });
}

/**
 * Load a comment and authorize against *its* workspace and brand.
 *
 * The scope has to come from the row rather than from the request, because
 * `comment:read_public` and `comment:reply` are brand-scoped for two roles: a
 * Content Creator assigned to one client must not be able to reply on another
 * client's channel by naming a comment id.
 *
 * `NotFoundError` for a comment in another tenant — which the scoped client
 * makes invisible anyway — so a probe cannot tell "not yours" from "no such
 * thing".
 */
async function requireComment(
  ctx: TenantContext,
  commentId: string,
  permission: 'comment:read_public' | 'comment:reply',
) {
  if (!isUserPrincipal(ctx.principal)) {
    throw new ForbiddenError('Community management needs a signed-in user', {
      userMessage: 'This action needs a signed-in user.',
      context: { actor: ctx.principal.actorName },
    });
  }

  const comment = await withTenant(ctx, (db) =>
    db.socialComment.findFirst({
      where: { id: commentId, postVariant: { deletedAt: null } },
      select: COMMENT_SELECT,
    }),
  );

  if (!comment) throw new NotFoundError('Comment');

  assertCan(ctx, permission, {
    workspaceId: comment.workspaceId,
    brandId: comment.brandId,
  });

  return comment;
}
