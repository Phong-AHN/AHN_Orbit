import { NotFoundError, accessibleWorkspaceIds, type TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';

/**
 * Publishing logs (SRS §14, API §2.8).
 *
 * Read-only views over the `PublishingJob` / `PublishingAttempt` ledger the
 * engine writes. No publishing logic lives here and no status is written — this
 * is the window onto T1.13's record, not a second copy of its rules.
 *
 * The selects are the whitelist. Every field returned is one already deemed
 * safe to render: a stable error code, the vetted message, timings, external
 * ids. A raw provider payload can carry a token fragment and is never stored,
 * so it cannot leak here either (SRS §33).
 */

/** Attempt fields safe to return. Deliberately explicit rather than a spread. */
const ATTEMPT_SELECT = {
  id: true,
  attemptNumber: true,
  state: true,
  startedAt: true,
  finishedAt: true,
  durationMs: true,
  externalPostId: true,
  errorCode: true,
  errorMessage: true,
  errorRetryable: true,
  httpStatus: true,
  // Whitelisted at write time by the engine (SRS §14).
  providerMeta: true,
  correlationId: true,
} as const;

const JOB_SELECT = {
  id: true,
  state: true,
  attemptCount: true,
  maxAttempts: true,
  scheduledFor: true,
  nextAttemptAt: true,
  lastErrorCode: true,
  createdAt: true,
  updatedAt: true,
  postVariant: {
    select: {
      id: true,
      status: true,
      platform: true,
      externalPostId: true,
      externalPermalink: true,
      publishedAt: true,
      lastError: true,
      socialAccount: { select: { id: true, displayName: true, handle: true, status: true } },
      post: {
        select: {
          id: true,
          title: true,
          body: true,
          status: true,
          workspaceId: true,
          brandId: true,
        },
      },
    },
  },
} as const;

export type PublishingJobState =
  'PENDING' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'DEAD_LETTER';

export interface PublishingLogFilter {
  state?: PublishingJobState | undefined;
  workspaceId?: string | undefined;
  brandId?: string | undefined;
  socialAccountId?: string | undefined;
  /** Only jobs whose variant is parked awaiting a human decision. */
  needsReviewOnly?: boolean | undefined;
  /** Only jobs that did not succeed — the default view for an operator. */
  failedOnly?: boolean | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  limit?: number | undefined;
  /** Opaque cursor: the id of the last row of the previous page. */
  cursor?: string | undefined;
}

export interface PublishingLogPage<T> {
  jobs: T[];
  /** Pass back as `cursor` for the next page. Null when there are no more. */
  nextCursor: string | null;
}

const DEFAULT_PAGE = 25;
const MAX_PAGE = 100;

/**
 * The job list (API §2.8).
 *
 * Cursor-paginated on `id`, which is UUIDv7 and therefore time-ordered — so a
 * cursor stays stable while new jobs arrive, which offset pagination would not.
 * Narrowed to the workspaces this principal can reach, on top of the tenant
 * scope the client already applies.
 */
export async function listPublishingJobs(
  ctx: TenantContext,
  filter: PublishingLogFilter = {},
): Promise<PublishingLogPage<Awaited<ReturnType<typeof fetchJobs>>[number]>> {
  const take = Math.min(Math.max(filter.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
  const rows = await fetchJobs(ctx, filter, take + 1);

  const hasMore = rows.length > take;
  const jobs = hasMore ? rows.slice(0, take) : rows;

  return {
    jobs,
    nextCursor: hasMore ? (jobs[jobs.length - 1]?.id ?? null) : null,
  };
}

async function fetchJobs(ctx: TenantContext, filter: PublishingLogFilter, take: number) {
  const workspaces = accessibleWorkspaceIds(ctx);

  return withTenant(ctx, (db) =>
    db.publishingJob.findMany({
      where: {
        ...(filter.state ? { state: filter.state } : {}),
        ...(filter.failedOnly ? { state: { in: ['FAILED', 'DEAD_LETTER'] as const } } : {}),
        ...(filter.from || filter.to
          ? {
              scheduledFor: {
                ...(filter.from ? { gte: filter.from } : {}),
                ...(filter.to ? { lte: filter.to } : {}),
              },
            }
          : {}),
        postVariant: {
          deletedAt: null,
          ...(filter.socialAccountId ? { socialAccountId: filter.socialAccountId } : {}),
          ...(filter.needsReviewOnly ? { status: 'NEEDS_REVIEW' as const } : {}),
          post: {
            deletedAt: null,
            ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
            ...(filter.brandId ? { brandId: filter.brandId } : {}),
            ...(workspaces === 'ALL' ? {} : { workspaceId: { in: [...workspaces] } }),
          },
        },
      },
      select: JOB_SELECT,
      // UUIDv7 sorts by creation time, so this is both a stable cursor and a
      // sensible order without a second sort column.
      orderBy: { id: 'desc' },
      ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
      take,
    }),
  );
}

/**
 * One job with its full attempt chain (API §2.8).
 *
 * The chain is the story: which attempt timed out, which one reconciled, what
 * the provider said each time. Ordered oldest-first because it reads as a
 * narrative.
 */
export async function getPublishingJob(ctx: TenantContext, jobId: string) {
  return withTenant(ctx, async (db) => {
    const job = await db.publishingJob.findFirst({
      where: { id: jobId },
      select: {
        ...JOB_SELECT,
        attempts: { select: ATTEMPT_SELECT, orderBy: { attemptNumber: 'asc' } },
      },
    });
    if (!job) throw new NotFoundError('Publishing job');
    return job;
  });
}

/**
 * Everything parked awaiting a human decision.
 *
 * The queue an operator actually works from: a variant in `NEEDS_REVIEW` is one
 * whose outcome could not be established, and nothing automated will touch it
 * again (decision D-027). Left unattended it stays that way forever, which is
 * why this needs to be visible rather than buried in a log line.
 */
export async function listNeedsReview(ctx: TenantContext, limit = 50) {
  const workspaces = accessibleWorkspaceIds(ctx);

  return withTenant(ctx, (db) =>
    db.postVariant.findMany({
      where: {
        status: 'NEEDS_REVIEW',
        deletedAt: null,
        post: {
          deletedAt: null,
          ...(workspaces === 'ALL' ? {} : { workspaceId: { in: [...workspaces] } }),
        },
      },
      select: {
        id: true,
        platform: true,
        scheduledFor: true,
        lastError: true,
        externalPostId: true,
        socialAccount: { select: { id: true, displayName: true } },
        post: { select: { id: true, title: true, body: true, workspaceId: true, brandId: true } },
        jobs: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            state: true,
            attemptCount: true,
            attempts: {
              orderBy: { attemptNumber: 'desc' },
              take: 1,
              select: ATTEMPT_SELECT,
            },
          },
        },
      },
      orderBy: { scheduledFor: 'asc' },
      take: Math.min(limit, MAX_PAGE),
    }),
  );
}

/** Counts for the dashboard and the log page's filter chips. */
export async function publishingSummary(ctx: TenantContext) {
  const workspaces = accessibleWorkspaceIds(ctx);

  const scope = {
    deletedAt: null,
    post: {
      deletedAt: null,
      ...(workspaces === 'ALL' ? {} : { workspaceId: { in: [...workspaces] } }),
    },
  };

  return withTenant(ctx, async (db) => {
    const grouped = await db.postVariant.groupBy({
      by: ['status'],
      where: scope,
      _count: { _all: true },
    });

    const counts = Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));

    return {
      published: counts.PUBLISHED ?? 0,
      failed: counts.FAILED ?? 0,
      needsReview: counts.NEEDS_REVIEW ?? 0,
      publishing: counts.PUBLISHING ?? 0,
      scheduled: counts.SCHEDULED ?? 0,
    };
  });
}

/** Resolve a job's post for the route-level permission check. */
export async function publishingJobScope(ctx: TenantContext, jobId: string) {
  return withTenant(ctx, async (db) => {
    const job = await db.publishingJob.findFirst({
      where: { id: jobId },
      select: {
        postVariant: {
          select: {
            post: {
              select: { workspaceId: true, brandId: true, createdById: true, status: true },
            },
          },
        },
      },
    });
    if (!job) throw new NotFoundError('Publishing job');
    return job.postVariant.post;
  });
}

/** Resolve a variant's post for the route-level permission check. */
export async function variantScope(ctx: TenantContext, variantId: string) {
  return withTenant(ctx, async (db) => {
    const variant = await db.postVariant.findFirst({
      where: { id: variantId, deletedAt: null },
      select: {
        post: { select: { workspaceId: true, brandId: true, createdById: true, status: true } },
      },
    });
    if (!variant) throw new NotFoundError('Post variant');
    return variant.post;
  });
}
