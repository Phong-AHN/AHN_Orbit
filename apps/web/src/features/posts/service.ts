import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  actorUserId,
  clock,
  contentHash,
  isEditLocked,
  isUserPrincipal,
  stageForStatus,
  type PostStatus,
  type TenantContext,
} from '@orbit/core';
import { withTenant, type TenantDb } from '@orbit/db';
import { assertTransitionAllowed } from '@orbit/rbac';
import { logger } from '@orbit/observability';
import { enqueue } from '@orbit/queue';
import { audit, type AuditInput } from '@/server/audit';
import { openGateFor, voidOpenGates } from '@/features/approvals/records';
import type { CreatePostInput, UpdatePostInput, UpdateVariantInput } from './contracts';
import { validatePost } from './validation';

/**
 * Post and variant management (T1.9).
 *
 * The rules this file exists to keep:
 *   • the state machine in @orbit/core is the only thing that moves status;
 *   • authorship comes from the session, never a request;
 *   • content is frozen once approved, and reopening voids the approvals;
 *   • every account reference is resolved through the tenant-scoped client, so
 *     a variant can never point at another organization's account.
 */

const POST_SELECT = {
  id: true,
  title: true,
  body: true,
  status: true,
  workspaceId: true,
  brandId: true,
  createdById: true,
  assignedToId: true,
  approvalRequired: true,
  scheduledFor: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const VARIANT_SELECT = {
  id: true,
  socialAccountId: true,
  platform: true,
  body: true,
  linkUrl: true,
  hashtags: true,
  mentions: true,
  firstComment: true,
  status: true,
  scheduledFor: true,
  externalPermalink: true,
  socialAccount: { select: { id: true, displayName: true, handle: true, status: true } },
} as const;

/** Resolve a post inside the tenant, or 404. */
async function requirePost(db: TenantDb, postId: string) {
  const post = await db.post.findFirst({
    where: { id: postId, deletedAt: null },
    select: { ...POST_SELECT, contentHash: true },
  });
  if (!post) throw new NotFoundError('Post');
  return post;
}

/**
 * Content is frozen from APPROVED onward.
 *
 * Editing an approved post silently would defeat the approval that was given,
 * so the only way back to editable is an explicit reopen transition — which
 * voids the approvals and starts a new round.
 */
function assertEditable(status: PostStatus): void {
  if (isEditLocked(status)) {
    throw new ConflictError(`Cannot edit a post in ${status}`, {
      userMessage:
        'This post is approved or already scheduled. Reopen it for editing — that will ask for approval again.',
      context: { status },
    });
  }
}

/**
 * Attach media to a post or a variant.
 *
 * Every asset is resolved through the scoped client and must be READY: an
 * unverified or rejected upload (T1.8) can never be attached, and an asset from
 * another tenant simply is not found.
 */
async function replaceMedia(
  db: TenantDb,
  organizationId: string,
  target: { postId: string; postVariantId?: string | undefined },
  media: ReadonlyArray<{ mediaAssetId: string; altText?: string | undefined }>,
): Promise<void> {
  const ids = media.map((m) => m.mediaAssetId);

  if (ids.length > 0) {
    const assets = await db.mediaAsset.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, status: true },
    });

    const byId = new Map(assets.map((a) => [a.id, a]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new NotFoundError('Media asset', {
        userMessage: 'One of the attached files could not be found.',
        context: { missing },
      });
    }

    const notReady = assets.filter((a) => a.status !== 'READY');
    if (notReady.length > 0) {
      throw new ValidationError('Media is not verified', {
        userMessage:
          'One of the attached files has not finished its safety checks, or failed them.',
        context: { notReady: notReady.map((a) => a.id) },
      });
    }
  }

  await db.postMedia.deleteMany({
    where: { postId: target.postId, postVariantId: target.postVariantId ?? null },
  });

  if (media.length > 0) {
    await db.postMedia.createMany({
      data: media.map((m, index) => ({
        organizationId,
        postId: target.postId,
        postVariantId: target.postVariantId ?? null,
        mediaAssetId: m.mediaAssetId,
        position: index,
        altText: m.altText ?? null,
      })),
    });
  }
}

/**
 * Reconcile the set of accounts a post targets.
 *
 * Adding an account creates a variant; removing one deletes it. A variant whose
 * account has already published is never removed — the record of what went out
 * has to survive.
 */
async function syncVariants(
  db: TenantDb,
  organizationId: string,
  postId: string,
  brandId: string,
  socialAccountIds: readonly string[],
): Promise<void> {
  const accounts = await db.socialAccount.findMany({
    where: { id: { in: [...socialAccountIds] }, brandId, deletedAt: null },
    select: { id: true, platform: true },
  });

  if (accounts.length !== socialAccountIds.length) {
    // Either an id from another tenant, or one belonging to a different brand.
    throw new NotFoundError('Social account', {
      userMessage: "One of the selected accounts isn't available for this brand.",
      context: { requested: socialAccountIds.length, found: accounts.length },
    });
  }

  const existing = await db.postVariant.findMany({
    where: { postId },
    select: { id: true, socialAccountId: true, status: true },
  });

  const wanted = new Set(socialAccountIds);
  const have = new Map(existing.map((v) => [v.socialAccountId, v]));

  const removable = existing.filter(
    (v) => !wanted.has(v.socialAccountId) && v.status !== 'PUBLISHED',
  );
  if (removable.length > 0) {
    await db.postMedia.deleteMany({
      where: { postVariantId: { in: removable.map((v) => v.id) } },
    });
    await db.postVariant.deleteMany({ where: { id: { in: removable.map((v) => v.id) } } });
  }

  for (const account of accounts) {
    if (have.has(account.id)) continue;
    await db.postVariant.create({
      data: {
        organizationId,
        postId,
        socialAccountId: account.id,
        platform: account.platform,
        status: 'DRAFT',
      },
    });
  }
}

// ── Create ──────────────────────────────────────────────────────────────────

export async function createPost(
  ctx: TenantContext,
  input: CreatePostInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const brand = await db.brand.findFirst({
      where: { id: input.brandId, workspaceId: input.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!brand) throw new NotFoundError('Brand');

    if (input.assignedToId) {
      await requireAssignable(db, input.assignedToId);
    }

    const post = await db.post.create({
      data: {
        organizationId: ctx.organizationId,
        workspaceId: input.workspaceId,
        brandId: input.brandId,
        title: input.title ?? null,
        body: input.body,
        // Authorship is the session's, never the request's.
        createdById: isUserPrincipal(ctx.principal) ? ctx.principal.userId : null,
        assignedToId: input.assignedToId ?? null,
        // Always starts as a draft; the state machine owns every move from here.
        status: 'DRAFT',
      },
      select: POST_SELECT,
    });

    if (input.media.length > 0) {
      await replaceMedia(db, ctx.organizationId, { postId: post.id }, input.media);
    }

    if (input.socialAccountIds.length > 0) {
      await syncVariants(db, ctx.organizationId, post.id, input.brandId, input.socialAccountIds);
    }

    // Master-level link and hashtags live on the variants, which is where
    // publishing reads them from.
    if (input.linkUrl || input.hashtags.length > 0 || input.mentions.length > 0) {
      await db.postVariant.updateMany({
        where: { postId: post.id },
        data: {
          linkUrl: input.linkUrl ?? null,
          hashtags: input.hashtags,
          mentions: input.mentions,
        },
      });
    }

    await audit(db, ctx, {
      action: 'post.created',
      resourceType: 'Post',
      resourceId: post.id,
      workspaceId: input.workspaceId,
      brandId: input.brandId,
      after: { title: post.title, accounts: input.socialAccountIds.length },
      ...fingerprint,
    });

    return post;
  });
}

async function requireAssignable(db: TenantDb, userId: string): Promise<void> {
  // Assignees must be members of this organization. User rows are not
  // tenant-scoped, so this membership check is the isolation boundary.
  const membership = await db.organizationMembership.findFirst({
    where: { userId, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!membership) {
    throw new NotFoundError('Member', {
      userMessage: 'That person is not a member of this organization.',
    });
  }
}

// ── Read ────────────────────────────────────────────────────────────────────

export async function getPost(ctx: TenantContext, postId: string) {
  return withTenant(ctx, async (db) => {
    const post = await db.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: {
        ...POST_SELECT,
        variants: { where: { deletedAt: null }, select: VARIANT_SELECT },
        media: {
          where: { postVariantId: null },
          orderBy: { position: 'asc' },
          select: {
            position: true,
            altText: true,
            mediaAsset: {
              select: { id: true, kind: true, mimeType: true, width: true, height: true },
            },
          },
        },
      },
    });
    if (!post) throw new NotFoundError('Post');
    return post;
  });
}

export async function listPosts(
  ctx: TenantContext,
  filter: {
    workspaceId?: string;
    brandId?: string;
    status?: PostStatus;
    accessibleWorkspaces?: 'ALL' | readonly string[];
    visibleStatuses?: readonly PostStatus[];
    limit?: number;
  } = {},
) {
  return withTenant(ctx, (db) =>
    db.post.findMany({
      where: {
        deletedAt: null,
        ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
        ...(filter.brandId ? { brandId: filter.brandId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        // A Client only ever sees content that has reached them; the caller
        // supplies the permitted set from the RBAC grant.
        ...(filter.visibleStatuses ? { status: { in: [...filter.visibleStatuses] } } : {}),
        ...(filter.accessibleWorkspaces && filter.accessibleWorkspaces !== 'ALL'
          ? { workspaceId: { in: [...filter.accessibleWorkspaces] } }
          : {}),
      },
      select: {
        ...POST_SELECT,
        variants: {
          where: { deletedAt: null },
          select: { id: true, platform: true, status: true, socialAccountId: true },
        },
      },
      orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'desc' }],
      take: Math.min(filter.limit ?? 50, 200),
    }),
  );
}

/**
 * Where a new post could go: every brand the viewer can reach, with the
 * accounts it can publish to.
 *
 * The composer opens on an existing post, so something has to answer "which
 * brand, and to which accounts?" before one exists. Keyed by brand rather than
 * workspace because that is what a post actually belongs to.
 *
 * `NEEDS_RECONNECT` accounts are included and marked rather than hidden:
 * writing a post for an account whose token has expired is entirely reasonable
 * — publishing is what will refuse, and it says so at the time. Silently
 * omitting the account would look like the account had been deleted.
 */
export async function listPublishTargets(
  ctx: TenantContext,
  accessible: 'ALL' | readonly string[],
) {
  return withTenant(ctx, (db) =>
    db.brand.findMany({
      where: {
        deletedAt: null,
        ...(accessible === 'ALL' ? {} : { workspaceId: { in: [...accessible] } }),
      },
      select: {
        id: true,
        name: true,
        workspaceId: true,
        workspace: { select: { id: true, name: true, timezone: true } },
        socialAccounts: {
          where: { deletedAt: null, status: { in: ['ACTIVE', 'NEEDS_RECONNECT'] } },
          select: { id: true, displayName: true, platform: true, status: true },
          orderBy: { displayName: 'asc' },
        },
      },
      orderBy: [{ workspaceId: 'asc' }, { name: 'asc' }],
    }),
  );
}

// ── Update ──────────────────────────────────────────────────────────────────

export async function updatePost(
  ctx: TenantContext,
  postId: string,
  input: UpdatePostInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const post = await requirePost(db, postId);
    assertEditable(post.status);

    if (input.assignedToId) await requireAssignable(db, input.assignedToId);

    const updated = await db.post.update({
      where: { id: postId },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.assignedToId !== undefined ? { assignedToId: input.assignedToId } : {}),
        ...(input.approvalRequired !== undefined
          ? { approvalRequired: input.approvalRequired }
          : {}),
      },
      select: POST_SELECT,
    });

    if (input.media !== undefined) {
      await replaceMedia(db, ctx.organizationId, { postId }, input.media);
    }

    if (input.socialAccountIds !== undefined) {
      await syncVariants(db, ctx.organizationId, postId, post.brandId, input.socialAccountIds);
    }

    if (
      input.linkUrl !== undefined ||
      input.hashtags !== undefined ||
      input.mentions !== undefined
    ) {
      await db.postVariant.updateMany({
        where: { postId },
        data: {
          ...(input.linkUrl !== undefined ? { linkUrl: input.linkUrl } : {}),
          ...(input.hashtags !== undefined ? { hashtags: input.hashtags } : {}),
          ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
        },
      });
    }

    await audit(db, ctx, {
      action: 'post.updated',
      resourceType: 'Post',
      resourceId: postId,
      workspaceId: post.workspaceId,
      brandId: post.brandId,
      before: { title: post.title, body: post.body.slice(0, 200) },
      after: { title: updated.title, body: updated.body.slice(0, 200) },
      ...fingerprint,
    });

    return updated;
  });
}

/**
 * Autosave the master copy.
 *
 * Not audited — a keystroke timer would drown the trail, and `post.updated`
 * already records deliberate saves. Returns the new `updatedAt` so the client
 * can carry it into the next call for conflict detection.
 */
export async function autosavePost(
  ctx: TenantContext,
  postId: string,
  input: {
    title?: string | null;
    body?: string;
    linkUrl?: string | null;
    hashtags?: string[];
    updatedAt?: string;
  },
) {
  return withTenant(ctx, async (db) => {
    const post = await requirePost(db, postId);
    assertEditable(post.status);

    if (input.updatedAt) {
      const seen = new Date(input.updatedAt).getTime();
      if (Number.isFinite(seen) && seen < post.updatedAt.getTime()) {
        throw new ConflictError('The post changed in another tab or by another person', {
          userMessage:
            'Someone else edited this post while you were writing. Reload to see the latest version.',
          context: { postId },
        });
      }
    }

    const updated = await db.post.update({
      where: { id: postId },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
      },
      select: { id: true, updatedAt: true },
    });

    if (input.linkUrl !== undefined || input.hashtags !== undefined) {
      await db.postVariant.updateMany({
        where: { postId },
        data: {
          ...(input.linkUrl !== undefined ? { linkUrl: input.linkUrl } : {}),
          ...(input.hashtags !== undefined ? { hashtags: input.hashtags } : {}),
        },
      });
    }

    return updated;
  });
}

/** Per-account override. Null clears the override and inherits again. */
export async function updateVariant(
  ctx: TenantContext,
  postId: string,
  variantId: string,
  input: UpdateVariantInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const post = await requirePost(db, postId);
    assertEditable(post.status);

    const variant = await db.postVariant.findFirst({
      where: { id: variantId, postId, deletedAt: null },
      select: { id: true, status: true, socialAccountId: true },
    });
    if (!variant) throw new NotFoundError('Post variant');

    if (variant.status === 'PUBLISHED' || variant.status === 'PUBLISHING') {
      throw new ConflictError('This account has already been published to', {
        userMessage: 'This account has already been published to and cannot be edited here.',
      });
    }

    const updated = await db.postVariant.update({
      where: { id: variantId },
      data: {
        ...(input.body !== undefined ? { body: input.body ?? '' } : {}),
        ...(input.linkUrl !== undefined ? { linkUrl: input.linkUrl } : {}),
        ...(input.hashtags !== undefined ? { hashtags: input.hashtags ?? [] } : {}),
        ...(input.mentions !== undefined ? { mentions: input.mentions ?? [] } : {}),
        ...(input.firstComment !== undefined ? { firstComment: input.firstComment } : {}),
      },
      select: VARIANT_SELECT,
    });

    if (input.media !== undefined) {
      await replaceMedia(
        db,
        ctx.organizationId,
        { postId, postVariantId: variantId },
        input.media ?? [],
      );
    }

    await audit(db, ctx, {
      action: 'post_variant.updated',
      resourceType: 'PostVariant',
      resourceId: variantId,
      workspaceId: post.workspaceId,
      brandId: post.brandId,
      after: { socialAccountId: variant.socialAccountId },
      ...fingerprint,
    });

    return updated;
  });
}

// ── Transition ──────────────────────────────────────────────────────────────

/**
 * The only way a post's status changes.
 *
 * `assertTransitionAllowed` consults the state machine *first*, so an illegal
 * move is a 409 regardless of role and a system-only status (PUBLISHING,
 * PUBLISHED, PARTIALLY_PUBLISHED, FAILED) is unreachable from here even for an
 * Owner. Only then is the permission checked.
 */
export interface TransitionOptions {
  /** Reviewer's note, recorded on the audit row. */
  comment?: string | undefined;
  /**
   * Runs inside the same transaction as the status change.
   *
   * Exists so a feature built on top of transitions — recording an approval
   * decision, say — commits or rolls back with the status rather than beside
   * it, without this module needing to know what that feature is.
   */
  onTransition?: ((db: TenantDb, post: { id: string }) => Promise<void>) | undefined;
}

export async function transitionPost(
  ctx: TenantContext,
  postId: string,
  to: PostStatus,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
  options: TransitionOptions = {},
) {
  const { comment, onTransition } = options;

  const { post, rule } = await withTenant(ctx, async (db) => {
    const found = await requirePost(db, postId);

    const transition = assertTransitionAllowed(ctx, found.status, to, {
      workspaceId: found.workspaceId,
      brandId: found.brandId,
      createdById: found.createdById,
    });

    // The client gate is a property of the post, not of the status pair, so the
    // transition table cannot express it. Approving internally is only the end
    // of review when the post does not also need the client's sign-off
    // (docs/RBAC.md §5); otherwise the only way on is through CLIENT_REVIEW.
    if (found.status === 'INTERNAL_REVIEW' && to === 'APPROVED' && found.approvalRequired) {
      throw new ConflictError('Client approval is required for this post', {
        userMessage:
          'This post needs the client to approve it. Send it to the client instead of approving it here.',
        context: { postId, from: found.status, to },
      });
    }

    return { post: found, rule: transition };
  });

  // Submitting for review must not be possible while the content cannot be
  // published; validating here is cheaper than discovering it at publish time.
  if (to === 'INTERNAL_REVIEW' || to === 'APPROVED' || to === 'SCHEDULED') {
    const validation = await validatePost(ctx, postId);
    if (!validation.valid) {
      throw new ValidationError('Post is not ready for this step', {
        userMessage: 'Fix the problems listed on the post before moving it forward.',
        details: [
          ...validation.postIssues
            .filter((i) => i.severity === 'ERROR')
            .map((i) => ({ field: i.field, issue: i.message })),
          ...validation.variants.flatMap((v) =>
            v.result.issues
              .filter((i) => i.severity === 'ERROR')
              .map((i) => ({ field: `${v.accountName}.${i.field}`, issue: i.message })),
          ),
        ],
      });
    }
  }

  const result = await withTenant(ctx, async (db) => {
    const updated = await db.post.update({
      where: { id: postId },
      data: {
        status: to,
        // Recomputed on every content-affecting move, so reconciliation and the
        // idempotency key always reflect what is actually going out.
        contentHash: contentHash({ body: post.body }),
      },
      select: POST_SELECT,
    });

    // The caller's own work, committed or rolled back with the status change.
    //
    // `schedulePost` supplies the callback that sets `scheduledFor`; the generic
    // transition endpoint supplies none, which is how a post reached SCHEDULED
    // with no date at all. That row is invisible on the calendar — which filters
    // on `scheduledFor` — and invisible to the scheduler sweep, which looks for
    // a due date. It simply sits there looking correct. The invariant is checked
    // below, after the callback has had its chance to satisfy it.
    //
    // Runs *before* the gate bookkeeping below, because a reviewer's decision
    // stamps the very record that bookkeeping would otherwise cancel. Once it
    // has run the decided gate is no longer PENDING, so it is left alone.
    await onTransition?.(db, updated);

    if (to === 'SCHEDULED') {
      // Re-read: the callback writes the date on the same row, so `updated`
      // above predates it.
      const scheduled = await db.post.findFirst({
        where: { id: postId },
        select: { scheduledFor: true },
      });

      if (!scheduled?.scheduledFor) {
        // Throwing rolls the whole transaction back, so the post stays where it
        // was rather than landing somewhere it can never leave.
        throw new ValidationError('A scheduled post must have a date', {
          userMessage: 'Choose when this should go out before scheduling it.',
          details: [{ field: 'scheduledFor', issue: 'required when scheduling' }],
          context: { postId },
        });
      }
    }

    // Close any gate that no longer applies.
    //
    // Two separate reasons, deliberately kept apart:
    //
    //   • the post has left the status the gate belonged to — whatever moved
    //     it. Relying on `voidsApprovals` alone left an orphan here: asking for
    //     changes from CLIENT_REVIEW moves the post on but is not a reopen, so
    //     the client's gate stayed pending in their queue forever.
    //   • the transition invalidates approvals already *granted* (reopening
    //     approved content), which is what `voidsApprovals` marks.
    const leftAGate = stageForStatus(post.status) !== null && post.status !== to;

    if (leftAGate || rule.voidsApprovals || to === 'CANCELED') {
      const voided = await voidOpenGates(db, postId);
      if (voided > 0) {
        logger.info('open approval gates closed', {
          postId,
          count: voided,
          from: post.status,
          to,
          reason: rule.voidsApprovals ? 'reopened' : to === 'CANCELED' ? 'canceled' : 'left gate',
        });
      }
    }

    if (to === 'CANCELED') {
      await db.postVariant.updateMany({
        where: { postId, status: { in: ['DRAFT', 'SCHEDULED'] } },
        data: { status: 'CANCELED' },
      });
    }

    // Entering a review status opens the corresponding gate, in this same
    // transaction — so a post can never sit in review with nothing queued.
    await openGateFor(db, ctx, updated, to);

    await audit(db, ctx, {
      action: 'post.transitioned',
      resourceType: 'Post',
      resourceId: postId,
      workspaceId: post.workspaceId,
      brandId: post.brandId,
      before: { status: post.status },
      after: { status: to },
      reason: comment,
      ...fingerprint,
    });

    return updated;
  });

  // After the commit, deliberately (T1.15).
  //
  // A notification about a transition that rolled back would be a lie, and one
  // enqueued inside the transaction could outlive it — BullMQ has no idea what
  // Postgres decided. Equally, a queue that is briefly unreachable must not
  // fail somebody's approval: the transition is the record, the notification is
  // a prompt, so `notifyTransition` swallows its own failures.
  await notifyTransition(ctx, result, to);

  return result;
}

/** Which transitions are worth telling someone about (SRS §22). */
function transitionEvent(
  to: PostStatus,
): 'post.approval_requested' | 'post.changes_requested' | null {
  switch (to) {
    // Both review gates read as "someone needs to look at this"; the processor
    // distinguishes internal from client from the post's own status.
    case 'INTERNAL_REVIEW':
    case 'CLIENT_REVIEW':
      return 'post.approval_requested';
    case 'CHANGES_REQUESTED':
      return 'post.changes_requested';
    default:
      return null;
  }
}

async function notifyTransition(
  ctx: TenantContext,
  post: { id: string; workspaceId: string },
  to: PostStatus,
): Promise<void> {
  const event = transitionEvent(to);
  if (!event) return;

  try {
    await enqueue('notifications', {
      organizationId: ctx.organizationId,
      correlationId: ctx.correlationId,
      event,
      resourceType: 'Post',
      resourceId: post.id,
      // So the reviewer who just asked for changes is not told about it.
      // Suppression only — it can remove a recipient, never add one.
      ...(actorUserId(ctx) ? { actorUserId: actorUserId(ctx) as string } : {}),
    });
  } catch (error) {
    logger.error('could not enqueue a transition notification', {
      postId: post.id,
      to,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ── Duplicate, assign, delete ───────────────────────────────────────────────

/** Copy content and targeting into a fresh draft. Publishing state is not copied. */
export async function duplicatePost(
  ctx: TenantContext,
  postId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const source = await db.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: {
        title: true,
        body: true,
        workspaceId: true,
        brandId: true,
        media: {
          where: { postVariantId: null },
          orderBy: { position: 'asc' },
          select: { mediaAssetId: true, altText: true },
        },
        variants: {
          where: { deletedAt: null },
          select: {
            socialAccountId: true,
            platform: true,
            body: true,
            linkUrl: true,
            hashtags: true,
            mentions: true,
            firstComment: true,
          },
        },
      },
    });
    if (!source) throw new NotFoundError('Post');

    const copy = await db.post.create({
      data: {
        organizationId: ctx.organizationId,
        workspaceId: source.workspaceId,
        brandId: source.brandId,
        title: source.title ? `${source.title} (copy)` : null,
        body: source.body,
        // A duplicate is always a fresh draft, authored by whoever copied it.
        status: 'DRAFT',
        createdById: isUserPrincipal(ctx.principal) ? ctx.principal.userId : null,
      },
      select: POST_SELECT,
    });

    if (source.media.length > 0) {
      await db.postMedia.createMany({
        data: source.media.map((m, index) => ({
          organizationId: ctx.organizationId,
          postId: copy.id,
          mediaAssetId: m.mediaAssetId,
          position: index,
          altText: m.altText,
        })),
      });
    }

    for (const variant of source.variants) {
      await db.postVariant.create({
        data: {
          organizationId: ctx.organizationId,
          postId: copy.id,
          socialAccountId: variant.socialAccountId,
          platform: variant.platform,
          body: variant.body,
          linkUrl: variant.linkUrl,
          hashtags: variant.hashtags,
          mentions: variant.mentions as object,
          firstComment: variant.firstComment,
          status: 'DRAFT',
        },
      });
    }

    await audit(db, ctx, {
      action: 'post.duplicated',
      resourceType: 'Post',
      resourceId: copy.id,
      workspaceId: source.workspaceId,
      brandId: source.brandId,
      after: { duplicatedFrom: postId },
      ...fingerprint,
    });

    return copy;
  });
}

export async function assignPost(
  ctx: TenantContext,
  postId: string,
  assignedToId: string | null,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const post = await requirePost(db, postId);
    if (assignedToId) await requireAssignable(db, assignedToId);

    const updated = await db.post.update({
      where: { id: postId },
      data: { assignedToId },
      select: POST_SELECT,
    });

    await audit(db, ctx, {
      action: 'post.assigned',
      resourceType: 'Post',
      resourceId: postId,
      workspaceId: post.workspaceId,
      brandId: post.brandId,
      before: { assignedToId: post.assignedToId },
      after: { assignedToId },
      ...fingerprint,
    });

    return updated;
  });
}

export async function deletePost(
  ctx: TenantContext,
  postId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const post = await requirePost(db, postId);

    // A published post's record must survive; cancel it instead.
    if (post.status === 'PUBLISHED' || post.status === 'PARTIALLY_PUBLISHED') {
      throw new ConflictError('Cannot delete a published post', {
        userMessage:
          'This post has already been published. Deleting it here would not remove it from the platform.',
        context: { status: post.status },
      });
    }

    if (post.status === 'PUBLISHING') {
      throw new ConflictError('Post is being published', {
        userMessage: 'This post is being published right now. Try again in a moment.',
      });
    }

    const now = clock.now();
    await db.post.update({ where: { id: postId }, data: { deletedAt: now } });
    await db.postVariant.updateMany({ where: { postId }, data: { deletedAt: now } });

    await audit(db, ctx, {
      action: 'post.deleted',
      resourceType: 'Post',
      resourceId: postId,
      workspaceId: post.workspaceId,
      brandId: post.brandId,
      before: { title: post.title, status: post.status },
      ...fingerprint,
    });
  });
}

/** Permission-check helper: who owns this post, and where does it live. */
export async function postScope(ctx: TenantContext, postId: string) {
  return withTenant(ctx, async (db) => {
    const post = await db.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: { workspaceId: true, brandId: true, createdById: true, status: true },
    });
    if (!post) throw new NotFoundError('Post');
    return post;
  });
}

export function assertNotSystemStatus(to: PostStatus): void {
  // Defence in depth: the state machine already refuses these for a human
  // actor, but a route that ever forgot to route through it would be caught.
  if (
    to === 'PUBLISHING' ||
    to === 'PUBLISHED' ||
    to === 'PARTIALLY_PUBLISHED' ||
    to === 'FAILED'
  ) {
    throw new ForbiddenError('That status is set automatically', {
      userMessage: 'That status is set automatically while publishing.',
    });
  }
}
