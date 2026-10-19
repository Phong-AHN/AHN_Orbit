import { NotFoundError, clock, type TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';
import { logger } from '@orbit/observability';
import { capabilitiesFor, getProvider } from '@orbit/providers';
import { loadAccountCredential } from '../credentials.js';

/**
 * Pulling audience comments back from the platforms (SRS §22).
 *
 * The read half of community management. The write half — replying — is
 * deliberately **not** here: a reply is initiated by a person and goes out from
 * the request they made, so this module and the capability set behind it hold
 * no permission to speak as the brand.
 *
 * ## Incremental, because the alternative does not scale
 *
 * A post with two thousand comments would otherwise be paged from the
 * beginning every run. Each pass asks only for comments newer than the newest
 * one already stored, which makes the steady-state cost proportional to what
 * arrived rather than to what exists.
 *
 * That watermark is read from our own rows rather than kept in a cursor column.
 * A stored cursor is a second source of truth that goes stale the moment a row
 * is deleted or an ingest half-fails; `max(postedAt)` cannot.
 *
 * ## It never fabricates
 *
 * A platform that cannot serve comments is reported as unsupported, not as a
 * post with no comments. The same rule analytics follows for a withdrawn
 * metric, and for the same reason: an absence and a zero are different facts.
 */

export type EngagementResult =
  | { kind: 'INGESTED'; created: number; updated: number; nextCursor?: string | undefined }
  | { kind: 'SKIPPED'; reason: 'NOT_PUBLISHED' | 'NOT_CONNECTED' | 'UNSUPPORTED' };

/** How many comments one job will take. A viral post is paged across jobs. */
const PAGE_SIZE = 100;

/**
 * A small overlap on the watermark.
 *
 * Platform timestamps have second granularity and are not guaranteed to be
 * monotonic with respect to when a comment becomes *visible* to the API, so
 * asking for strictly-newer-than drops anything that arrived in the same
 * second as the last one we saw. Re-reading a minute costs one page and the
 * unique index makes it idempotent, which is the cheap side of the trade.
 */
const WATERMARK_OVERLAP_MS = 60_000;

export async function ingestPostComments(input: {
  ctx: TenantContext;
  postVariantId: string;
  correlationId: string;
  cursor?: string | undefined;
}): Promise<EngagementResult> {
  const { ctx, postVariantId, cursor } = input;

  const variant = await withTenant(ctx, (db) =>
    db.postVariant.findFirst({
      where: { id: postVariantId, deletedAt: null },
      select: {
        id: true,
        platform: true,
        status: true,
        externalPostId: true,
        post: { select: { workspaceId: true, brandId: true } },
        socialAccount: {
          select: { id: true, externalId: true, accountType: true, status: true },
        },
      },
    }),
  );

  if (!variant) throw new NotFoundError('Post variant');

  // Nothing to read. A variant that never published has no platform object,
  // and asking about one is an error rather than an empty result.
  if (variant.status !== 'PUBLISHED' || !variant.externalPostId) {
    return { kind: 'SKIPPED', reason: 'NOT_PUBLISHED' };
  }

  if (variant.socialAccount.status === 'REVOKED' || variant.socialAccount.status === 'DISABLED') {
    return { kind: 'SKIPPED', reason: 'NOT_CONNECTED' };
  }

  const capabilities = capabilitiesFor(variant.platform, variant.socialAccount.accountType);
  const provider = getProvider(variant.platform);

  // Both halves checked: the descriptor says whether the platform can, and the
  // method says whether this adapter has implemented it. A descriptor that
  // claims a capability an adapter lacks is a bug, and crashing a queue is a
  // worse way to find out than skipping.
  if (!capabilities.engagement.readComments || !provider.fetchComments) {
    return { kind: 'SKIPPED', reason: 'UNSUPPORTED' };
  }

  const credential = await loadAccountCredential(ctx, variant.socialAccount.id);

  // No scope check here. `engagement.replyScopes` gates *answering* a comment,
  // not reading one — reading is covered by whatever the platform already
  // requests to read content, which on Facebook is the analytics set. The
  // first version of this checked `replyScopes` before reading and was dead
  // code: a connection can legitimately read a queue it cannot reply to, and
  // the reply path is where that is caught.
  const since = cursor ? undefined : await watermarkFor(ctx, variant.id);

  const page = await provider.fetchComments({
    ref: {
      externalPostId: variant.externalPostId,
      accountExternalId: variant.socialAccount.externalId,
    },
    credential,
    limit: PAGE_SIZE,
    ...(since ? { since } : {}),
    ...(cursor ? { cursor } : {}),
  });

  let created = 0;
  let updated = 0;

  for (const comment of page.comments) {
    /**
     * `findFirst` then `create`/`update`, not `upsert`.
     *
     * The db layer refuses `upsert` outright and is right to: it cannot be
     * tenant-scoped, because the `where` of an upsert is a unique constraint
     * lookup that the scoping extension has no way to narrow. The explicit form
     * runs inside `withTenant`, so both halves are scoped — and it also gives
     * an exact created/updated count rather than one inferred by comparing
     * timestamps.
     */
    await withTenant(ctx, async (db) => {
      const existing = await db.socialComment.findFirst({
        where: { socialAccountId: variant.socialAccount.id, externalId: comment.externalId },
        select: { id: true },
      });

      if (existing) {
        /**
         * Platform facts only.
         *
         * `state`, `assignedToId`, `handledAt` and `handledById` are the
         * agency's own work and ingestion must not touch them — re-reading a
         * thread every few minutes would otherwise reopen every comment
         * somebody had already dealt with, on a loop, forever.
         *
         * `parentExternalId` is on the platform's side of that line, and it is
         * here because a platform can move a reply. Instagram does: it accepts
         * a reply aimed at another reply and attaches it to the top-level
         * comment instead, so the parent recorded when we sent it is not where
         * it ended up. Letting the next pass correct it is what keeps the
         * thread we render the same as the one the public sees — and without
         * it such a reply hangs off a parent nothing threads on, so it
         * disappears from the thread view entirely.
         */
        await db.socialComment.update({
          where: { id: existing.id },
          data: {
            message: comment.message,
            ...(comment.authorName ? { authorName: comment.authorName } : {}),
            ...(comment.permalink ? { permalink: comment.permalink } : {}),
            // Written even when absent, so a reply the platform promoted to
            // top level stops claiming a parent it no longer has.
            parentExternalId: comment.parentExternalId ?? null,
          },
        });
        updated += 1;
        return;
      }

      await db.socialComment.create({
        data: {
          organizationId: ctx.organizationId,
          workspaceId: variant.post.workspaceId,
          brandId: variant.post.brandId,
          socialAccountId: variant.socialAccount.id,
          postVariantId: variant.id,
          externalId: comment.externalId,
          ...(comment.parentExternalId ? { parentExternalId: comment.parentExternalId } : {}),
          origin: comment.ours ? 'ORBIT' : 'AUDIENCE',
          ...(comment.authorName ? { authorName: comment.authorName } : {}),
          message: comment.message,
          ...(comment.permalink ? { permalink: comment.permalink } : {}),
          postedAt: comment.postedAt,
          // The brand's own reply is not a thing needing attention. Marked
          // handled on arrival, which is also what lets a reply sent outside
          // Orbit — from the Facebook app, by the client themselves — close a
          // comment in the queue here.
          ...(comment.ours
            ? { state: 'HANDLED' as const, handledAt: clock.now() }
            : { state: 'NEW' as const }),
        },
      });
      created += 1;
    });
  }

  logger.debug('ingested audience comments', {
    postVariantId: variant.id,
    socialAccountId: variant.socialAccount.id,
    fetched: page.comments.length,
    created,
    updated,
  });

  return {
    kind: 'INGESTED',
    created,
    updated,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

/**
 * The newest comment already stored for this variant, less a small overlap.
 *
 * Undefined on the first pass, which is what makes the first ingest read the
 * whole thread and every later one read only the tail.
 */
async function watermarkFor(ctx: TenantContext, postVariantId: string): Promise<Date | undefined> {
  const newest = await withTenant(ctx, (db) =>
    db.socialComment.findFirst({
      where: { postVariantId },
      select: { postedAt: true },
      orderBy: { postedAt: 'desc' },
    }),
  );

  if (!newest) return undefined;

  return new Date(newest.postedAt.getTime() - WATERMARK_OVERLAP_MS);
}
