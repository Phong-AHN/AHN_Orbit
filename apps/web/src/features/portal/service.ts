import { NotFoundError, type PostStatus, type TenantContext } from '@orbit/core';
import { withTenant, type TenantDb } from '@orbit/db';
import { CLIENT_VISIBLE_STATUSES } from '@orbit/rbac';
import { assertKeyBelongsTo, presignDownload } from '@orbit/storage';
import {
  PORTAL_APPROVAL_SELECT,
  PORTAL_COMMENT_SELECT,
  PORTAL_MEDIA_SELECT,
  PORTAL_POST_SELECT,
  PORTAL_VARIANT_SELECT,
  PORTAL_WORKSPACE_SELECT,
} from './projection';

/**
 * The client portal's read services (SRS §21, decision D-012).
 *
 * Its own code path, its own selects, its own tests — **not** the agency
 * services with a filter. The reason is structural rather than stylistic: with a
 * shared read path, every field added for the agency is a field a reviewer has
 * to remember to exclude from the client's view, and the failure mode of
 * forgetting is a silent leak rather than a broken build.
 *
 * Three narrowings apply to every query here, and all three are in the `where`:
 *
 *  1. **tenant** — via the scoped client, as everywhere else;
 *  2. **workspace** — to the one the portal wrapper resolved and confirmed the
 *     client belongs to. Never "their workspaces" plural inside a service: the
 *     wrapper has already established which single workspace this request is
 *     about, and passing it explicitly keeps the check and the query together;
 *  3. **status** — to `CLIENT_VISIBLE_STATUSES`, so a draft or an internal
 *     review is not merely hidden but never selected.
 *
 * Writes are *not* reimplemented here. A portal decision goes through
 * `decideApproval` and therefore through the one state machine (**D-017**), and
 * a portal comment goes through `createComment`, which already forces a Client's
 * comment to `CLIENT_VISIBLE`. Duplicating either would be a second workflow
 * engine, which is exactly what the handoff forbids.
 */

/** How long a portal media URL stays valid. Short, like every other signed URL. */
const MEDIA_URL_TTL_SECONDS = 900;

/** The statuses a portal query may ever return. */
const VISIBLE: readonly PostStatus[] = CLIENT_VISIBLE_STATUSES;

/**
 * The workspaces this client may see.
 *
 * Driven by `WorkspaceMembership`, so a client with two brands under one agency
 * sees two entries and a client of a different agency sees none of them. The
 * organization is never named in the response: the client deals with a brand,
 * not with the agency's internal tenant.
 */
export async function listPortalWorkspaces(ctx: TenantContext, workspaceIds: readonly string[]) {
  if (workspaceIds.length === 0) return [];

  return withTenant(ctx, (db) =>
    db.workspace.findMany({
      where: { id: { in: [...workspaceIds] }, deletedAt: null },
      select: PORTAL_WORKSPACE_SELECT,
      orderBy: { name: 'asc' },
    }),
  );
}

export interface PortalCalendarFilter {
  from: Date;
  to: Date;
  limit?: number;
}

/**
 * What is coming up, and what has gone out.
 *
 * Ordered by the time the client cares about — when it publishes — rather than
 * when the agency created it.
 */
export async function listPortalCalendar(
  ctx: TenantContext,
  workspaceId: string,
  filter: PortalCalendarFilter,
) {
  return withTenant(ctx, (db) =>
    db.post.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        status: { in: [...VISIBLE] },
        OR: [
          { scheduledFor: { gte: filter.from, lte: filter.to } },
          { publishedAt: { gte: filter.from, lte: filter.to } },
        ],
      },
      select: PORTAL_POST_SELECT,
      orderBy: [{ scheduledFor: 'asc' }, { publishedAt: 'asc' }],
      take: Math.min(filter.limit ?? 100, 200),
    }),
  );
}

/**
 * Posts waiting on this client.
 *
 * Narrowed to `stage: 'CLIENT'` **and** `state: 'PENDING'` **and** a post in
 * `CLIENT_REVIEW`. Any one of those alone would be a leak: an internal gate is
 * not theirs, a decided gate is history, and a post that has moved on is no
 * longer a question being asked of them.
 */
export async function listPortalApprovals(ctx: TenantContext, workspaceId: string) {
  return withTenant(ctx, (db) =>
    db.approval.findMany({
      where: {
        stage: 'CLIENT',
        state: 'PENDING',
        post: { workspaceId, deletedAt: null, status: 'CLIENT_REVIEW' },
      },
      select: {
        ...PORTAL_APPROVAL_SELECT,
        post: { select: PORTAL_POST_SELECT },
      },
      orderBy: { requestedAt: 'asc' },
      take: 100,
    }),
  );
}

/** Published work, newest first — what the client shows their own stakeholders. */
export async function listPortalPublished(ctx: TenantContext, workspaceId: string, limit = 50) {
  const posts = await withTenant(ctx, (db) =>
    db.post.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        status: { in: ['PUBLISHED', 'PARTIALLY_PUBLISHED'] },
      },
      select: {
        ...PORTAL_POST_SELECT,
        variants: {
          // Only variants that actually went out. A variant still pending, or
          // one that failed, is agency business until it is resolved.
          where: { deletedAt: null, status: 'PUBLISHED' },
          select: PORTAL_VARIANT_SELECT,
        },
      },
      orderBy: { publishedAt: 'desc' },
      take: Math.min(limit, 100),
    }),
  );

  return posts;
}

export interface PortalPostView {
  post: unknown;
  media: unknown[];
  comments: unknown[];
  approval: unknown | null;
}

/**
 * One post, as the client sees it.
 *
 * The status narrowing is part of the lookup, so a post in `DRAFT` or
 * `INTERNAL_REVIEW` is a **404** rather than a 403 — a client cannot learn that
 * a post exists before it reaches them. That is the same reasoning that makes an
 * internal comment a 404 in T1.10, and the same reason a cross-tenant id is a
 * 404 everywhere else.
 */
export async function getPortalPost(ctx: TenantContext, workspaceId: string, postId: string) {
  const found = await withTenant(ctx, async (db) => {
    const post = await db.post.findFirst({
      where: {
        id: postId,
        workspaceId,
        deletedAt: null,
        status: { in: [...VISIBLE] },
      },
      select: {
        ...PORTAL_POST_SELECT,
        variants: {
          where: { deletedAt: null },
          select: PORTAL_VARIANT_SELECT,
          orderBy: { platform: 'asc' },
        },
      },
    });

    if (!post) throw new NotFoundError('Post');

    const [media, comments, approval] = await Promise.all([
      loadMedia(db, postId),
      db.comment.findMany({
        where: { postId, deletedAt: null, visibility: 'CLIENT_VISIBLE' },
        select: PORTAL_COMMENT_SELECT,
        orderBy: { createdAt: 'asc' },
      }),
      db.approval.findFirst({
        where: { postId, stage: 'CLIENT' },
        select: PORTAL_APPROVAL_SELECT,
        orderBy: [{ round: 'desc' }, { requestedAt: 'desc' }],
      }),
    ]);

    return { post, media, comments, approval };
  });

  return {
    ...found,
    media: await signMedia(ctx.organizationId, found.media),
  };
}

/** Client-visible comments on a post. Same narrowing as the post view. */
export async function listPortalComments(ctx: TenantContext, workspaceId: string, postId: string) {
  return withTenant(ctx, async (db) => {
    await requireVisiblePost(db, workspaceId, postId);

    return db.comment.findMany({
      where: { postId, deletedAt: null, visibility: 'CLIENT_VISIBLE' },
      select: PORTAL_COMMENT_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  });
}

/**
 * Confirm a post is one this client may act on at all.
 *
 * Used by the write paths before they delegate. The delegated services run their
 * own authorization — this is not a substitute for it — but it means a portal
 * write against an invisible post fails as a 404 here rather than surfacing a
 * different error shape from deeper in.
 */
export async function requirePortalPost(
  ctx: TenantContext,
  workspaceId: string,
  postId: string,
): Promise<{ id: string; status: PostStatus; brandId: string }> {
  return withTenant(ctx, (db) => requireVisiblePost(db, workspaceId, postId));
}

async function requireVisiblePost(db: TenantDb, workspaceId: string, postId: string) {
  const post = await db.post.findFirst({
    where: { id: postId, workspaceId, deletedAt: null, status: { in: [...VISIBLE] } },
    select: { id: true, status: true, brandId: true },
  });
  if (!post) throw new NotFoundError('Post');
  return post;
}

/**
 * Post-level attachments.
 *
 * Only `READY` assets, matching the rule that an unverified upload never reaches
 * a platform (T1.8) — and, here, never reaches a client either.
 */
async function loadMedia(db: TenantDb, postId: string) {
  const rows = await db.postMedia.findMany({
    where: { postId, postVariantId: null, mediaAsset: { deletedAt: null, status: 'READY' } },
    select: { altText: true, position: true, mediaAsset: { select: PORTAL_MEDIA_SELECT } },
    orderBy: { position: 'asc' },
  });

  return rows;
}

/**
 * Swap storage keys for short-lived signed URLs.
 *
 * `storageKey` is dropped here rather than merely omitted from the render: the
 * payload is the boundary, and a key that reaches the browser is a key that
 * reaches anywhere the browser can paste it. `assertKeyBelongsTo` re-checks the
 * tenant prefix before signing, so even a mis-joined row cannot produce a URL
 * for another organization's object.
 */
async function signMedia(
  organizationId: string,
  rows: Array<{
    altText: string | null;
    position: number;
    mediaAsset: { id: string; kind: string; mimeType: string; storageKey: string } & Record<
      string,
      unknown
    >;
  }>,
) {
  return Promise.all(
    rows.map(async ({ altText, position, mediaAsset }) => {
      const { storageKey, ...asset } = mediaAsset;
      assertKeyBelongsTo(storageKey, organizationId);

      const { url } = await presignDownload({
        key: storageKey,
        contentType: mediaAsset.mimeType,
        inline: true,
        expiresInSeconds: MEDIA_URL_TTL_SECONDS,
      });

      return { altText, position, asset, url };
    }),
  );
}
