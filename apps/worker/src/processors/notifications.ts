import { NotFoundError, ValidationError, presentFailure, type ErrorCode } from '@orbit/core';
import { NOTIFICATION_WORKER_CAPABILITIES } from '@orbit/auth';
import { withTenant, type TenantDb } from '@orbit/db';
import { logger } from '@orbit/observability';
import { isNotificationType, notify, type NotificationType } from '@orbit/notifications';
import type { JobContext } from '@orbit/queue';
import { resolveTenantForJob } from '../context.js';

/**
 * Job entry point for the notifications queue (T1.15).
 *
 * The payload names the **subject**, never the audience: "this variant failed",
 * not "tell Ana and Ben". Recipients are worked out here, from live memberships
 * and the real policy engine, because a producer that listed them would be a
 * producer that could get a disclosure wrong — and the queue is durable shared
 * state, so a stale job would keep getting it wrong.
 *
 * The display facts are resolved here too, for the same reason publishing
 * resolves its content at publish time: a job queued before an edit must
 * describe what the post *is*, not what it was.
 */
export async function processNotification(job: JobContext<'notifications'>): Promise<void> {
  const { payload, correlationId } = job;

  if (!isNotificationType(payload.event)) {
    // An unknown event cannot be rendered or fanned out. Failing loudly beats
    // writing a notification nobody can read.
    throw new ValidationError(`Unknown notification event: ${payload.event}`, {
      context: { event: payload.event, jobId: job.jobId },
    });
  }

  const event = payload.event;

  // ── Tenant derivation (decision D-021) ──────────────────────────────────────
  const { ctx } = await resolveTenantForJob({
    queue: 'notifications',
    jobId: job.jobId,
    claimedOrganizationId: payload.organizationId,
    subject: {
      subjectType:
        payload.resourceType === 'PostVariant'
          ? 'postVariant'
          : payload.resourceType === 'Post'
            ? 'post'
            : 'socialAccount',
      subjectId: payload.resourceId,
    },
    actorName: 'notification-worker',
    capabilities: NOTIFICATION_WORKER_CAPABILITIES,
    correlationId,
  });

  await withTenant(ctx, async (db) => {
    const described = await describe(db, event, payload.resourceId);

    if (!described) {
      // The subject was deleted between enqueue and now. Nothing to say.
      logger.info('notification subject no longer exists; skipping', {
        event,
        resourceId: payload.resourceId,
      });
      return;
    }

    await notify(db, ctx, {
      ...described,
      excludeUsers: [payload.actorUserId],
    });
  });
}

type Described = Parameters<typeof notify>[2];

/**
 * Turn a subject id into the facts a notification is written from.
 *
 * Returns `null` when the subject has gone — a post deleted between the event
 * and its fan-out is not an error, it is a race that resolves in favour of
 * saying nothing.
 */
async function describe(
  db: TenantDb,
  event: NotificationType,
  resourceId: string,
): Promise<Described | null> {
  switch (event) {
    case 'publishing.failed':
    case 'publishing.needs_review': {
      const variant = await db.postVariant.findFirst({
        where: { id: resourceId, deletedAt: null },
        select: {
          lastError: true,
          post: {
            select: {
              id: true,
              title: true,
              body: true,
              status: true,
              workspaceId: true,
              brandId: true,
              createdById: true,
            },
          },
          socialAccount: { select: { displayName: true } },
        },
      });

      if (!variant) return null;

      const post = variant.post;

      return {
        event:
          event === 'publishing.failed'
            ? {
                type: 'publishing.failed',
                postTitle: postLabel(post.title, post.body),
                accountName: variant.socialAccount.displayName,
                // The same wording the publishing log shows, so the two agree.
                summary: presentFailure(errorCodeOf(variant.lastError)).summary,
              }
            : {
                type: 'publishing.needs_review',
                postTitle: postLabel(post.title, post.body),
                accountName: variant.socialAccount.displayName,
              },
        resource: {
          resourceType: 'Post',
          resourceId: post.id,
          workspaceId: post.workspaceId,
          brandId: post.brandId,
        },
        scope: { postStatus: post.status, createdById: post.createdById },
      };
    }

    case 'post.approval_requested':
    case 'post.changes_requested': {
      const post = await db.post.findFirst({
        where: { id: resourceId, deletedAt: null },
        select: {
          id: true,
          title: true,
          body: true,
          status: true,
          workspaceId: true,
          brandId: true,
          createdById: true,
          assignedToId: true,
        },
      });

      if (!post) return null;

      return {
        event:
          event === 'post.approval_requested'
            ? {
                type: 'post.approval_requested',
                postTitle: postLabel(post.title, post.body),
                stage: post.status === 'CLIENT_REVIEW' ? 'CLIENT' : 'INTERNAL',
              }
            : { type: 'post.changes_requested', postTitle: postLabel(post.title, post.body) },
        resource: {
          resourceType: 'Post',
          resourceId: post.id,
          workspaceId: post.workspaceId,
          brandId: post.brandId,
        },
        scope: { postStatus: post.status, createdById: post.createdById },
        // Changes go back to the people who have to make them, whether or not
        // their role would otherwise put them in scope. Still filtered by
        // visibility — being the author is interest, not access.
        ...(event === 'post.changes_requested'
          ? { includeUsers: [post.createdById, post.assignedToId] }
          : {}),
      };
    }

    // Account health is written inline, in the same transaction as the status
    // change (T1.7, decision D-033), so it never travels through this queue.
    case 'social_account.needs_reconnect':
    case 'social_account.reconnected':
      throw new NotFoundError('Account health notifications are written inline, not queued');

    default: {
      const exhaustive: never = event;
      throw new Error(`Unhandled notification event: ${String(exhaustive)}`);
    }
  }
}

/** The stored `lastError` is `{ code, message }`; only the code drives copy. */
function errorCodeOf(value: unknown): ErrorCode | null {
  if (value && typeof value === 'object' && 'code' in value) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string') return code as ErrorCode;
  }
  return null;
}

/** A post has no mandatory title, so fall back to the opening of its body. */
function postLabel(title: string | null, body: string): string {
  if (title && title.trim().length > 0) return title.trim();
  const opening = body.trim().slice(0, 50);
  return opening.length > 0 ? opening : 'Untitled post';
}
