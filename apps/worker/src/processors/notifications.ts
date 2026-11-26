import { NotFoundError, ValidationError, presentFailure, type ErrorCode } from '@orbit/core';
import { NOTIFICATION_WORKER_CAPABILITIES } from '@orbit/auth';
import { withTenant, type TenantDb } from '@orbit/db';
import { logError, logger } from '@orbit/observability';
import {
  isNotificationType,
  notify,
  slackWants,
  type NotificationEvent,
  type NotificationType,
} from '@orbit/notifications';
import { enqueue, type JobContext } from '@orbit/queue';
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

  const forSlack = await withTenant(ctx, async (db) => {
    const described = await describeNotification(db, event, payload.resourceId);

    if (!described) {
      // The subject was deleted between enqueue and now. Nothing to say.
      logger.info('notification subject no longer exists; skipping', {
        event,
        resourceId: payload.resourceId,
      });
      return false;
    }

    await notify(db, ctx, {
      ...described,
      excludeUsers: [payload.actorUserId],
    });

    const organization = await db.organization.findFirst({ select: { settings: true } });
    return slackWants(organization?.settings, event);
  });

  // After the commit, and never able to fail this job: the in-app rows are
  // written, and a retry here would write them all again (D-129).
  if (forSlack) {
    try {
      await enqueue(
        'slack',
        {
          organizationId: payload.organizationId,
          correlationId,
          event,
          resourceType: payload.resourceType,
          resourceId: payload.resourceId,
        },
        // A retried notifications job does not post twice.
        { jobId: `slack-${job.jobId}` },
      );
    } catch (error) {
      logError('could not queue a Slack message', error, {
        event,
        organizationId: ctx.organizationId,
        resourceId: payload.resourceId,
      });
    }
  }
}

type Described = Parameters<typeof notify>[2];

/**
 * Turn a subject id into the facts a notification is written from.
 *
 * Returns `null` when the subject has gone — a post deleted between the event
 * and its fan-out is not an error, it is a race that resolves in favour of
 * saying nothing.
 *
 * Exported for the Slack processor (D-129), so the channel and the bell are
 * written from the same facts.
 */
export async function describeNotification(
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
          /**
           * The last attempt's own words (D-129). The variant's `lastError`
           * holds the per-code sentence; the attempt holds what the adapter
           * actually said, which is what someone fixing the post needs.
           */
          jobs: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              attempts: {
                where: { errorMessage: { not: null } },
                orderBy: { attemptNumber: 'desc' },
                take: 1,
                select: { errorMessage: true },
              },
            },
          },
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
                detail:
                  variant.jobs[0]?.attempts[0]?.errorMessage ?? errorMessageOf(variant.lastError),
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
    case 'post.client_review_requested':
    case 'post.changes_requested':
    case 'post.approved': {
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
          /**
           * The decision that produced this transition, for the two events that
           * report one.
           *
           * Read from the record rather than carried on the job, which is the
           * same choice `stage` already made below. A payload would have to be
           * trusted and kept in step with whatever the state machine actually
           * wrote; the row is what happened.
           */
          approvals: {
            where: { state: { in: ['APPROVED', 'CHANGES_REQUESTED'] } },
            orderBy: [{ decidedAt: 'desc' }],
            take: 1,
            select: {
              stage: true,
              comment: true,
              onBehalfOf: true,
              decidedBy: { select: { name: true } },
            },
          },
        },
      });

      if (!post) return null;

      const title = postLabel(post.title, post.body);
      const decision = post.approvals[0];
      const fromClient = decision?.stage === 'CLIENT';

      /**
       * Who to name, for an agency reader.
       *
       * Withheld when a client's decision was **recorded by staff on their
       * behalf** (docs/RBAC.md note 5). The decider on that row is the staff
       * member, and naming them would report a colleague as the client. The
       * copy falls back to "The client", which is the accurate statement: it
       * was the client's decision, and who keyed it in is in the audit log.
       */
      const by = decision?.onBehalfOf ? null : (decision?.decidedBy?.name ?? null);

      return {
        event: buildReviewEvent(event, title, fromClient, by, decision?.comment ?? null),
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

    case 'publishing.published': {
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
          variants: {
            where: { deletedAt: null, status: { in: ['PUBLISHED', 'FAILED', 'NEEDS_REVIEW'] } },
            orderBy: { createdAt: 'asc' },
            select: {
              status: true,
              externalPermalink: true,
              socialAccount: { select: { displayName: true } },
            },
          },
        },
      });

      if (!post) return null;

      const live = post.variants.filter((variant) => variant.status === 'PUBLISHED');
      // Raised when a post settles with something live; if nothing is live by
      // now, there is no good news to give.
      if (live.length === 0) return null;

      return {
        event: {
          type: 'publishing.published',
          postTitle: postLabel(post.title, post.body),
          live: live.slice(0, MAX_LINKS).map((variant) => ({
            accountName: variant.socialAccount.displayName,
            permalink: variant.externalPermalink,
          })),
          partial: live.length < post.variants.length,
        },
        resource: {
          resourceType: 'Post',
          resourceId: post.id,
          workspaceId: post.workspaceId,
          brandId: post.brandId,
        },
        scope: { postStatus: post.status, createdById: post.createdById },
        includeUsers: [post.createdById, post.assignedToId, await scheduledBy(db, post.id)],
      };
    }

    case 'post.canceled':
    case 'post.unscheduled': {
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

      const title = postLabel(post.title, post.body);
      // From the audit row the transition wrote, not from the job — the same
      // choice the review events make: the record is what happened.
      const by = await movedBy(db, post.id, event === 'post.canceled' ? 'CANCELED' : 'DRAFT');

      return {
        event:
          event === 'post.canceled'
            ? { type: 'post.canceled', postTitle: title, by }
            : { type: 'post.unscheduled', postTitle: title, by },
        resource: {
          resourceType: 'Post',
          resourceId: post.id,
          workspaceId: post.workspaceId,
          brandId: post.brandId,
        },
        scope: { postStatus: post.status, createdById: post.createdById },
        includeUsers: [post.createdById, post.assignedToId, await scheduledBy(db, post.id)],
      };
    }

    // Account health is written inline, in the same transaction as the status
    // change (T1.7, decision D-033), so it never travels through this queue.
    case 'social_account.needs_reconnect':
    case 'social_account.reconnected':
      throw new NotFoundError('Account health notifications are written inline, not queued');

    // Written inline by message ingestion, in the transaction that opened the
    // conversation (D-107) — the same choice account health makes.
    case 'message.received':
    case 'message.needs_human':
      throw new NotFoundError('Message notifications are written inline, not queued');

    default: {
      const exhaustive: never = event;
      throw new Error(`Unhandled notification event: ${String(exhaustive)}`);
    }
  }
}

/**
 * Build the event for a review transition.
 *
 * Separated from the query so the one rule that matters here is visible in one
 * place: **the client-facing event is given no agency facts.** It takes the post
 * title and nothing else — no decider, no note, no stage — because a row
 * written for a client is read by that client for as long as it exists, and the
 * safe way to keep a name out of it is for there to be no field to put one in.
 */
function buildReviewEvent(
  event:
    | 'post.approval_requested'
    | 'post.client_review_requested'
    | 'post.changes_requested'
    | 'post.approved',
  postTitle: string,
  fromClient: boolean,
  by: string | null,
  note: string | null,
): NotificationEvent {
  switch (event) {
    case 'post.approval_requested':
      // Still both gates, and still only the wording that differs: this is the
      // agency's copy. The client's own prompt is a separate event, because it
      // goes to different people — which is what the old single type got wrong.
      return {
        type: 'post.approval_requested',
        postTitle,
        stage: fromClient ? 'CLIENT' : 'INTERNAL',
      };

    case 'post.client_review_requested':
      return { type: 'post.client_review_requested', postTitle };

    case 'post.changes_requested':
      return { type: 'post.changes_requested', postTitle, fromClient, by, note };

    case 'post.approved':
      return { type: 'post.approved', postTitle, fromClient, by };
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

/**
 * The stored `lastError`'s sentence, for a failure no attempt recorded — a
 * publish the queue gave up on, a platform not set up (D-128). The engine
 * writes only vetted text there, never a provider payload.
 */
function errorMessageOf(value: unknown): string | null {
  if (value && typeof value === 'object' && 'message' in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) return message;
  }
  return null;
}

/** More links than this is a post nobody reads the list of. */
const MAX_LINKS = 20;

/**
 * Who put the post on the schedule, from the audit row `schedulePost` writes.
 *
 * Often not the author: a writer drafts, an account manager schedules. Both
 * want to know when it goes out or comes off (D-129).
 */
async function scheduledBy(db: TenantDb, postId: string): Promise<string | null> {
  const row = await db.auditLog.findFirst({
    where: { resourceType: 'Post', resourceId: postId, action: 'post.scheduled' },
    orderBy: { createdAt: 'desc' },
    select: { actorUserId: true },
  });
  return row?.actorUserId ?? null;
}

/**
 * The name of whoever last moved the post to `status`, if a person did.
 *
 * Read from the newest transition row and only believed when that row is the
 * move being reported — a post canceled and then touched again must not name
 * whoever touched it.
 */
async function movedBy(db: TenantDb, postId: string, status: string): Promise<string | null> {
  const row = await db.auditLog.findFirst({
    where: { resourceType: 'Post', resourceId: postId, action: 'post.transitioned' },
    orderBy: { createdAt: 'desc' },
    select: { after: true, actorUser: { select: { name: true } } },
  });

  const after = row?.after;
  const movedTo =
    after && typeof after === 'object' && !Array.isArray(after)
      ? (after as Record<string, unknown>)['status']
      : undefined;

  return movedTo === status ? (row?.actorUser?.name ?? null) : null;
}

/** A post has no mandatory title, so fall back to the opening of its body. */
function postLabel(title: string | null, body: string): string {
  if (title && title.trim().length > 0) return title.trim();
  const opening = body.trim().slice(0, 50);
  return opening.length > 0 ? opening : 'Untitled post';
}
