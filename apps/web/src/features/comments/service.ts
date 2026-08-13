import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  actorUserId,
  clock,
  isUserPrincipal,
  type CommentVisibility,
  type TenantContext,
} from '@orbit/core';
import { withTenant, type TenantDb } from '@orbit/db';
import { audit, type AuditInput } from '@/server/audit';

/**
 * Comments and review threads (SRS §16, §21).
 *
 * The rule that matters: **internal chatter never reaches a client.** That is
 * enforced here, server-side, by narrowing the query — not by a frontend filter
 * and not by a flag the request supplies. A Client's read is confined to
 * `CLIENT_VISIBLE` rows before the database is asked, and their writes are
 * forced to `CLIENT_VISIBLE` regardless of what they sent.
 */

const COMMENT_SELECT = {
  id: true,
  postId: true,
  postVariantId: true,
  parentId: true,
  body: true,
  visibility: true,
  mentionedUserIds: true,
  resolvedAt: true,
  resolvedById: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, name: true, email: true, avatarUrl: true } },
} as const;

function isClient(ctx: TenantContext): boolean {
  return isUserPrincipal(ctx.principal) && ctx.principal.organizationRole === 'CLIENT';
}

async function requirePost(db: TenantDb, postId: string) {
  const post = await db.post.findFirst({
    where: { id: postId, deletedAt: null },
    select: { id: true, workspaceId: true, brandId: true, status: true },
  });
  if (!post) throw new NotFoundError('Post');
  return post;
}

export interface CreateCommentInput {
  body: string;
  /** Ignored for a Client, who can only ever write a client-visible comment. */
  visibility?: CommentVisibility | undefined;
  postVariantId?: string | undefined;
  parentId?: string | undefined;
  mentionedUserIds?: string[] | undefined;
}

export async function createComment(
  ctx: TenantContext,
  postId: string,
  input: CreateCommentInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const post = await requirePost(db, postId);

    // A Client's comment is always client-visible. Honouring a requested
    // `INTERNAL` would let them write into a thread they cannot read back.
    const visibility: CommentVisibility = isClient(ctx)
      ? 'CLIENT_VISIBLE'
      : (input.visibility ?? 'INTERNAL');

    if (input.postVariantId) {
      const variant = await db.postVariant.findFirst({
        where: { id: input.postVariantId, postId, deletedAt: null },
        select: { id: true },
      });
      if (!variant) throw new NotFoundError('Post variant');
    }

    if (input.parentId) {
      // A reply must join a thread on this post — and one this principal can
      // actually see, so a Client cannot reply into an internal thread and have
      // their reply hang off a parent they were never shown.
      const parent = await db.comment.findFirst({
        where: {
          id: input.parentId,
          postId,
          deletedAt: null,
          ...(isClient(ctx) ? { visibility: 'CLIENT_VISIBLE' } : {}),
        },
        select: { id: true, visibility: true },
      });
      if (!parent) throw new NotFoundError('Comment');

      // A reply cannot be more visible than the thread it joins.
      if (parent.visibility === 'INTERNAL' && visibility === 'CLIENT_VISIBLE') {
        throw new ValidationError('Cannot add a client-visible reply to an internal thread', {
          userMessage:
            'This thread is internal. Start a new comment to share something externally.',
        });
      }
    }

    const mentioned = await resolveMentions(db, input.mentionedUserIds ?? []);

    const comment = await db.comment.create({
      data: {
        organizationId: ctx.organizationId,
        postId,
        postVariantId: input.postVariantId ?? null,
        parentId: input.parentId ?? null,
        // Authorship comes from the session, never the request.
        authorId: actorUserId(ctx),
        body: input.body,
        visibility,
        mentionedUserIds: mentioned,
      },
      select: COMMENT_SELECT,
    });

    await audit(db, ctx, {
      action: 'comment.created',
      resourceType: 'Comment',
      resourceId: comment.id,
      workspaceId: post.workspaceId,
      brandId: post.brandId,
      after: { visibility, postId, mentions: mentioned.length },
      ...fingerprint,
    });

    return comment;
  });
}

/**
 * Keep only mentioned users who are actually members of this organization.
 *
 * `User` rows are not tenant-scoped, so an arbitrary uuid would otherwise be
 * storable — and later resolved into a name by whatever renders the mention.
 * Silently dropping unknown ids is right here: a mention is a convenience, and
 * failing the whole comment over one stale id would be worse than posting it.
 */
async function resolveMentions(db: TenantDb, userIds: readonly string[]): Promise<string[]> {
  if (userIds.length === 0) return [];

  const members = await db.organizationMembership.findMany({
    where: { userId: { in: [...userIds] }, status: 'ACTIVE' },
    select: { userId: true },
  });

  return members.map((m) => m.userId);
}

/**
 * Read a post's comments.
 *
 * The visibility narrowing is applied to the query, so an internal comment is
 * never loaded for a Client in the first place — there is no filtered-after-the-
 * fact step that a future refactor could drop.
 */
export async function listComments(ctx: TenantContext, postId: string) {
  return withTenant(ctx, async (db) => {
    await requirePost(db, postId);

    return db.comment.findMany({
      where: {
        postId,
        deletedAt: null,
        ...(isClient(ctx) ? { visibility: 'CLIENT_VISIBLE' } : {}),
      },
      select: COMMENT_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  });
}

export async function updateComment(
  ctx: TenantContext,
  commentId: string,
  body: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const comment = await requireVisibleComment(db, ctx, commentId);

    // Editing someone else's words is not a thing any role does, whatever their
    // permission — so this is checked here rather than in the grant matrix.
    if (comment.authorId !== actorUserId(ctx)) {
      throw new ForbiddenError('Only the author can edit a comment', {
        userMessage: 'You can only edit your own comments.',
      });
    }

    const updated = await db.comment.update({
      where: { id: commentId },
      data: { body },
      select: COMMENT_SELECT,
    });

    await audit(db, ctx, {
      action: 'comment.updated',
      resourceType: 'Comment',
      resourceId: commentId,
      before: { body: comment.body.slice(0, 200) },
      after: { body: body.slice(0, 200) },
      ...fingerprint,
    });

    return updated;
  });
}

export async function resolveComment(
  ctx: TenantContext,
  commentId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const comment = await requireVisibleComment(db, ctx, commentId);

    if (comment.resolvedAt) {
      throw new ConflictError('Comment thread is already resolved', {
        userMessage: 'This thread has already been resolved.',
      });
    }

    const updated = await db.comment.update({
      where: { id: commentId },
      data: { resolvedAt: clock.now(), resolvedById: actorUserId(ctx) },
      select: COMMENT_SELECT,
    });

    await audit(db, ctx, {
      action: 'comment.resolved',
      resourceType: 'Comment',
      resourceId: commentId,
      ...fingerprint,
    });

    return updated;
  });
}

export async function deleteComment(
  ctx: TenantContext,
  commentId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const comment = await requireVisibleComment(db, ctx, commentId);

    if (comment.authorId !== actorUserId(ctx)) {
      throw new ForbiddenError('Only the author can delete a comment', {
        userMessage: 'You can only delete your own comments.',
      });
    }

    await db.comment.update({ where: { id: commentId }, data: { deletedAt: clock.now() } });

    await audit(db, ctx, {
      action: 'comment.deleted',
      resourceType: 'Comment',
      resourceId: commentId,
      before: { body: comment.body.slice(0, 200) },
      ...fingerprint,
    });
  });
}

/**
 * Resolve a comment the principal is allowed to have seen.
 *
 * The visibility narrowing is part of the lookup, so an internal comment is a
 * 404 for a Client rather than a 403 — they have no way to learn it exists.
 */
async function requireVisibleComment(db: TenantDb, ctx: TenantContext, commentId: string) {
  const comment = await db.comment.findFirst({
    where: {
      id: commentId,
      deletedAt: null,
      ...(isClient(ctx) ? { visibility: 'CLIENT_VISIBLE' } : {}),
    },
    select: {
      id: true,
      body: true,
      authorId: true,
      visibility: true,
      resolvedAt: true,
      post: { select: { workspaceId: true, brandId: true, createdById: true, status: true } },
    },
  });
  if (!comment) throw new NotFoundError('Comment');
  return comment;
}

/** Resolve a comment's post for the route-level permission check. */
export async function commentScope(ctx: TenantContext, commentId: string) {
  return withTenant(ctx, async (db) => {
    const comment = await requireVisibleComment(db, ctx, commentId);
    return comment.post;
  });
}
