import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  contentHash,
  type TenantContext,
} from '@orbit/core';
import { devIdentityProvider, resolveTenantContext, resolveUser } from '@orbit/auth';
import { platformDb } from '@orbit/db';
import { closeQueues, closeSharedConnection } from '@orbit/queue';
import {
  getPublishingJob,
  listNeedsReview,
  listPublishingJobs,
  publishingJobScope,
  publishingSummary,
  variantScope,
} from './logs';
import { resolveParkedVariant } from './resolve';
import { retryPublishingJob } from './service';

/**
 * Publishing logs and failure handling against the real database (T1.14).
 *
 * Two things these prove that a unit test cannot: that the log surface never
 * returns anything unsafe even when the ledger holds a failure, and that
 * resolving a parked publish routes back through the engine rather than around
 * it.
 */

const ORG = '019a1100-0000-7000-8000-00a110000001';
const ORG_B = '019a1200-0000-7000-8000-00a120000001';
const WS = '019a1100-0000-7000-8000-00a110000002';
const WS_OTHER = '019a1100-0000-7000-8000-00a110000012';
const BRAND = '019a1100-0000-7000-8000-00a110000003';
const BRAND_OTHER = '019a1100-0000-7000-8000-00a110000013';
const ACCOUNT = '019a1100-0000-7000-8000-00a110000004';
const ACCOUNT_OTHER = '019a1100-0000-7000-8000-00a110000014';
const OWNER = '019a1100-0000-7000-8000-00a110000005';
const CREATOR = '019a1100-0000-7000-8000-00a110000006';
const OWNER_B = '019a1200-0000-7000-8000-00a120000005';

const fingerprint = { ip: '127.0.0.1', userAgent: 'vitest' };
const BODY = 'A perfectly ordinary announcement.';
const HASH = contentHash({ body: BODY });

let owner: TenantContext;
let creator: TenantContext;
let ownerB: TenantContext;

let variantId: string;
let jobId: string;

async function contextFor(email: string, orgId: string): Promise<TenantContext> {
  const user = await resolveUser(await devIdentityProvider.verifyIdToken(`dev:${email}`));
  return (await resolveTenantContext(user, orgId)).ctx;
}

/**
 * A post with one variant, one job, and one attempt — in whatever state the
 * test needs. Written directly, because the log surface is what is under test.
 */
async function seed(options: {
  variantStatus: 'PUBLISHED' | 'FAILED' | 'NEEDS_REVIEW' | 'SCHEDULED' | 'PUBLISHING';
  jobState: 'SUCCEEDED' | 'FAILED' | 'DEAD_LETTER' | 'QUEUED';
  attemptState?: 'SUCCEEDED' | 'FAILED' | 'RECONCILED' | 'INCONCLUSIVE';
  errorCode?: string;
  errorMessage?: string;
  workspaceId?: string;
  brandId?: string;
  accountId?: string;
}) {
  const post = await platformDb.post.create({
    data: {
      organizationId: ORG,
      workspaceId: options.workspaceId ?? WS,
      brandId: options.brandId ?? BRAND,
      body: BODY,
      status: 'PUBLISHED',
      scheduledFor: new Date('2026-06-15T12:00:00Z'),
      publishedAt: new Date('2026-06-15T12:00:01Z'),
    },
  });

  const variant = await platformDb.postVariant.create({
    data: {
      organizationId: ORG,
      postId: post.id,
      socialAccountId: options.accountId ?? ACCOUNT,
      platform: 'FACEBOOK',
      body: '',
      status: options.variantStatus,
      scheduledFor: new Date('2026-06-15T12:00:00Z'),
      contentHash: HASH,
      // A DB check constraint requires an external id alongside PUBLISHED —
      // there is no such thing as a published variant with nothing to point at.
      ...(options.variantStatus === 'PUBLISHED'
        ? { externalPostId: `ext-post-${Math.random().toString(36).slice(2, 10)}` }
        : {}),
      ...(options.errorCode
        ? {
            lastError: {
              code: options.errorCode,
              message: options.errorMessage ?? 'Something safe to render.',
            },
          }
        : {}),
    },
  });

  const job = await platformDb.publishingJob.create({
    data: {
      organizationId: ORG,
      postVariantId: variant.id,
      idempotencyKey: `publish:${variant.id}:key`,
      scheduledFor: new Date('2026-06-15T12:00:00Z'),
      state: options.jobState,
      attemptCount: 1,
      ...(options.errorCode ? { lastErrorCode: options.errorCode } : {}),
    },
  });

  if (options.attemptState) {
    await platformDb.publishingAttempt.create({
      data: {
        organizationId: ORG,
        publishingJobId: job.id,
        attemptNumber: 1,
        state: options.attemptState,
        correlationId: 'seed-correlation',
        startedAt: new Date('2026-06-15T12:00:00Z'),
        finishedAt: new Date('2026-06-15T12:00:02Z'),
        durationMs: 2000,
        ...(options.errorCode
          ? {
              errorCode: options.errorCode,
              errorMessage: options.errorMessage ?? 'Something safe to render.',
              errorRetryable: false,
            }
          : {}),
      },
    });
  }

  return { postId: post.id, variantId: variant.id, jobId: job.id };
}

beforeAll(async () => {
  for (const [org, slug] of [
    [ORG, 't14a'],
    [ORG_B, 't14b'],
  ] as const) {
    await platformDb.organization.upsert({
      where: { id: org },
      update: {},
      create: { id: org, name: slug, slug, timezone: 'UTC' },
    });
  }

  for (const [ws, brand, account, slug] of [
    [WS, BRAND, ACCOUNT, 'main'],
    [WS_OTHER, BRAND_OTHER, ACCOUNT_OTHER, 'other'],
  ] as const) {
    await platformDb.workspace.upsert({
      where: { id: ws },
      update: {},
      create: { id: ws, organizationId: ORG, name: slug, slug, timezone: 'UTC' },
    });
    await platformDb.brand.upsert({
      where: { id: brand },
      update: {},
      create: { id: brand, organizationId: ORG, workspaceId: ws, name: slug, slug },
    });
    await platformDb.socialAccount.upsert({
      where: { id: account },
      update: {},
      create: {
        id: account,
        organizationId: ORG,
        workspaceId: ws,
        brandId: brand,
        platform: 'FACEBOOK',
        externalId: `ext-${slug}`,
        displayName: `Page ${slug}`,
        accountType: 'PAGE',
        status: 'ACTIVE',
      },
    });
  }

  await platformDb.workspace.upsert({
    where: { id: '019a1200-0000-7000-8000-00a120000002' },
    update: {},
    create: {
      id: '019a1200-0000-7000-8000-00a120000002',
      organizationId: ORG_B,
      name: 'b',
      slug: 'b',
      timezone: 'UTC',
    },
  });

  for (const [userId, email, org, role, ws] of [
    [OWNER, 'owner@t14.test', ORG, 'OWNER', WS],
    [CREATOR, 'creator@t14.test', ORG, 'CONTENT_CREATOR', WS],
    [OWNER_B, 'ownerb@t14.test', ORG_B, 'OWNER', '019a1200-0000-7000-8000-00a120000002'],
  ] as const) {
    await platformDb.user.upsert({
      where: { id: userId },
      update: {},
      create: { id: userId, firebaseUid: `dev:${email}`, email },
    });
    await platformDb.organizationMembership.upsert({
      where: { organizationId_userId: { organizationId: org, userId } },
      update: { role, status: 'ACTIVE' },
      create: { organizationId: org, userId, role, status: 'ACTIVE' },
    });
    await platformDb.workspaceMembership.upsert({
      where: { workspaceId_userId: { workspaceId: ws, userId } },
      update: {},
      create: {
        organizationId: org,
        workspaceId: ws,
        userId,
        role: role === 'OWNER' ? 'MANAGER' : 'CONTRIBUTOR',
      },
    });
  }

  owner = await contextFor('owner@t14.test', ORG);
  creator = await contextFor('creator@t14.test', ORG);
  ownerB = await contextFor('ownerb@t14.test', ORG_B);
});

beforeEach(async () => {
  await platformDb.publishingAttempt.deleteMany({ where: { organizationId: ORG } });
  await platformDb.publishingJob.deleteMany({ where: { organizationId: ORG } });
  await platformDb.postVariant.deleteMany({ where: { organizationId: ORG } });
  await platformDb.post.deleteMany({ where: { organizationId: ORG } });
  await platformDb.auditLog.deleteMany({ where: { organizationId: ORG } });

  const seeded = await seed({
    variantStatus: 'FAILED',
    jobState: 'FAILED',
    attemptState: 'FAILED',
    errorCode: 'PROVIDER_VALIDATION_ERROR',
  });

  variantId = seeded.variantId;
  jobId = seeded.jobId;
});

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG, ORG_B] } } });
  await platformDb.user.deleteMany({ where: { id: { in: [OWNER, CREATOR, OWNER_B] } } });
  await platformDb.$disconnect();
  await closeQueues();
  await closeSharedConnection();
});

// ── The job list ────────────────────────────────────────────────────────────

describe('the job list', () => {
  it('returns jobs with their variant and post', async () => {
    const page = await listPublishingJobs(owner);

    expect(page.jobs).toHaveLength(1);
    expect(page.jobs[0]).toMatchObject({ id: jobId, state: 'FAILED' });
    expect(page.jobs[0]?.postVariant.socialAccount.displayName).toBe('Page main');
  });

  it('filters to failures', async () => {
    await seed({ variantStatus: 'PUBLISHED', jobState: 'SUCCEEDED', attemptState: 'SUCCEEDED' });

    expect((await listPublishingJobs(owner)).jobs).toHaveLength(2);
    expect((await listPublishingJobs(owner, { failedOnly: true })).jobs).toHaveLength(1);
  });

  it('filters to parked variants', async () => {
    await seed({
      variantStatus: 'NEEDS_REVIEW',
      jobState: 'DEAD_LETTER',
      attemptState: 'INCONCLUSIVE',
      errorCode: 'PUBLISHING_TIMEOUT',
    });

    const page = await listPublishingJobs(owner, { needsReviewOnly: true });

    expect(page.jobs).toHaveLength(1);
    expect(page.jobs[0]?.postVariant.status).toBe('NEEDS_REVIEW');
  });

  it('filters by account and by workspace', async () => {
    await seed({
      variantStatus: 'PUBLISHED',
      jobState: 'SUCCEEDED',
      workspaceId: WS_OTHER,
      brandId: BRAND_OTHER,
      accountId: ACCOUNT_OTHER,
    });

    expect((await listPublishingJobs(owner, { workspaceId: WS })).jobs).toHaveLength(1);
    expect((await listPublishingJobs(owner, { socialAccountId: ACCOUNT_OTHER })).jobs).toHaveLength(
      1,
    );
  });

  it('paginates on a stable cursor', async () => {
    for (let i = 0; i < 4; i += 1) {
      await seed({ variantStatus: 'PUBLISHED', jobState: 'SUCCEEDED' });
    }

    const first = await listPublishingJobs(owner, { limit: 2 });
    expect(first.jobs).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listPublishingJobs(owner, { limit: 2, cursor: first.nextCursor ?? '' });
    expect(second.jobs).toHaveLength(2);

    // No overlap between pages.
    const ids = new Set([...first.jobs, ...second.jobs].map((job) => job.id));
    expect(ids.size).toBe(4);
  });

  it('reports no further pages at the end', async () => {
    const page = await listPublishingJobs(owner, { limit: 25 });
    expect(page.nextCursor).toBeNull();
  });

  it('confines a workspace-scoped principal to their own workspaces', async () => {
    await seed({
      variantStatus: 'FAILED',
      jobState: 'FAILED',
      workspaceId: WS_OTHER,
      brandId: BRAND_OTHER,
      accountId: ACCOUNT_OTHER,
    });

    // The Content Creator belongs to WS only.
    const visible = await listPublishingJobs(creator);

    expect(visible.jobs).toHaveLength(1);
    expect(visible.jobs[0]?.postVariant.post.workspaceId).toBe(WS);
  });

  it('never shows another tenant jobs', async () => {
    expect((await listPublishingJobs(ownerB)).jobs).toHaveLength(0);
  });
});

// ── Job detail ──────────────────────────────────────────────────────────────

describe('job detail', () => {
  it('includes the attempt chain oldest first', async () => {
    await platformDb.publishingAttempt.create({
      data: {
        organizationId: ORG,
        publishingJobId: jobId,
        attemptNumber: 2,
        state: 'INCONCLUSIVE',
        correlationId: 'second',
        startedAt: new Date('2026-06-15T12:05:00Z'),
      },
    });

    const job = await getPublishingJob(owner, jobId);

    expect(job.attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2]);
  });

  it('returns only whitelisted attempt fields', async () => {
    const job = await getPublishingJob(owner, jobId);
    const attempt = job.attempts[0];

    // Everything a human needs.
    expect(attempt).toHaveProperty('errorCode');
    expect(attempt).toHaveProperty('errorMessage');
    expect(attempt).toHaveProperty('correlationId');

    // And nothing a human should not have. The engine never stores these, so
    // the point is that the select does not invent a path to them.
    const serialised = JSON.stringify(job);
    expect(serialised).not.toContain('accessToken');
    expect(serialised).not.toContain('Ciphertext');
    expect(serialised).not.toContain('claimToken');
  });

  it('hides another tenant job behind a 404', async () => {
    await expect(getPublishingJob(ownerB, jobId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(publishingJobScope(ownerB, jobId)).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── Needs review ────────────────────────────────────────────────────────────

describe('the needs-review queue', () => {
  it('lists only parked variants', async () => {
    const parked = await seed({
      variantStatus: 'NEEDS_REVIEW',
      jobState: 'DEAD_LETTER',
      attemptState: 'INCONCLUSIVE',
      errorCode: 'PUBLISHING_TIMEOUT',
      errorMessage: 'We could not confirm whether this published.',
    });

    const items = await listNeedsReview(owner);

    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(parked.variantId);
    expect(JSON.stringify(items[0]?.lastError)).toContain('could not confirm');
  });

  it('is empty when nothing is parked', async () => {
    expect(await listNeedsReview(owner)).toHaveLength(0);
  });

  it('never shows another tenant parked variants', async () => {
    await seed({ variantStatus: 'NEEDS_REVIEW', jobState: 'DEAD_LETTER' });
    expect(await listNeedsReview(ownerB)).toHaveLength(0);
  });

  it('summarises counts by state', async () => {
    await seed({ variantStatus: 'PUBLISHED', jobState: 'SUCCEEDED' });
    await seed({ variantStatus: 'NEEDS_REVIEW', jobState: 'DEAD_LETTER' });

    const summary = await publishingSummary(owner);

    expect(summary).toMatchObject({ published: 1, failed: 1, needsReview: 1 });
  });
});

// ── Resolving a parked publish ──────────────────────────────────────────────

describe('resolving a parked publish', () => {
  async function parked() {
    return seed({
      variantStatus: 'NEEDS_REVIEW',
      jobState: 'DEAD_LETTER',
      attemptState: 'INCONCLUSIVE',
      errorCode: 'PUBLISHING_TIMEOUT',
    });
  }

  it('records that it had published', async () => {
    const { variantId: parkedId } = await parked();

    await resolveParkedVariant(
      owner,
      parkedId,
      {
        resolution: 'PUBLISHED',
        reason: 'Opened the Page — the post is live, timestamped 09:02.',
        externalPostId: '123_456',
      },
      fingerprint,
    );

    const variant = await platformDb.postVariant.findUnique({ where: { id: parkedId } });
    expect(variant?.status).toBe('PUBLISHED');
    expect(variant?.externalPostId).toBe('123_456');
    expect(variant?.publishedAt).not.toBeNull();
  });

  it('returns it to the engine when it had not published', async () => {
    const { variantId: parkedId } = await parked();

    await resolveParkedVariant(
      owner,
      parkedId,
      { resolution: 'NOT_PUBLISHED', reason: 'Checked the Page — nothing there.' },
      fingerprint,
    );

    // SCHEDULED at a new instant, so the engine derives a *new* idempotency key
    // and all four layers apply again. Nothing published directly here.
    const variant = await platformDb.postVariant.findUnique({ where: { id: parkedId } });
    expect(variant?.status).toBe('SCHEDULED');
    expect(variant?.externalPostId).toBeNull();
    expect(variant?.scheduledFor?.getTime()).toBeGreaterThan(
      new Date('2026-06-15T12:00:00Z').getTime(),
    );
  });

  it('gives up when asked to', async () => {
    const { variantId: parkedId } = await parked();

    await resolveParkedVariant(
      owner,
      parkedId,
      { resolution: 'ABANDON', reason: 'Client pulled the campaign.' },
      fingerprint,
    );

    const variant = await platformDb.postVariant.findUnique({ where: { id: parkedId } });
    expect(variant?.status).toBe('FAILED');
  });

  it('requires a reason', async () => {
    const { variantId: parkedId } = await parked();

    await expect(
      resolveParkedVariant(
        owner,
        parkedId,
        { resolution: 'PUBLISHED', reason: '   ' },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    const variant = await platformDb.postVariant.findUnique({ where: { id: parkedId } });
    expect(variant?.status).toBe('NEEDS_REVIEW');
  });

  it('requires the post id when confirming it published', async () => {
    // A DB check constraint requires it too. Without something to point at,
    // "it published" is an unverifiable claim — and reconciliation and
    // analytics both need the id downstream.
    const { variantId: parkedId } = await parked();

    await expect(
      resolveParkedVariant(
        owner,
        parkedId,
        { resolution: 'PUBLISHED', reason: 'I saw it, honest' },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    const variant = await platformDb.postVariant.findUnique({ where: { id: parkedId } });
    expect(variant?.status).toBe('NEEDS_REVIEW');
  });

  it('does not require a post id to say it did not publish', async () => {
    const { variantId: parkedId } = await parked();

    await expect(
      resolveParkedVariant(
        owner,
        parkedId,
        { resolution: 'NOT_PUBLISHED', reason: 'Nothing on the Page.' },
        fingerprint,
      ),
    ).resolves.toMatchObject({ resolution: 'NOT_PUBLISHED' });
  });

  it('audits the decision with its reason', async () => {
    const { variantId: parkedId } = await parked();

    await resolveParkedVariant(
      owner,
      parkedId,
      {
        resolution: 'PUBLISHED',
        reason: 'Saw it on the Page at 09:02.',
        externalPostId: '123_456',
      },
      fingerprint,
    );

    const entry = await platformDb.auditLog.findFirst({
      where: { organizationId: ORG, action: 'post_variant.publish_resolved' },
    });

    expect(entry?.reason).toBe('Saw it on the Page at 09:02.');
    expect(entry?.actorUserId).toBe(OWNER);
  });

  it('refuses a variant that is not parked', async () => {
    // The seeded default is FAILED, not NEEDS_REVIEW.
    await expect(
      resolveParkedVariant(
        owner,
        variantId,
        { resolution: 'PUBLISHED', reason: 'it is there', externalPostId: '9_9' },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses another tenant variant', async () => {
    const { variantId: parkedId } = await parked();

    await expect(
      resolveParkedVariant(
        ownerB,
        parkedId,
        { resolution: 'PUBLISHED', reason: 'not mine', externalPostId: '9_9' },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(variantScope(ownerB, parkedId)).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── Retry ───────────────────────────────────────────────────────────────────

describe('retrying a job', () => {
  it('returns the variant to the engine', async () => {
    const result = await retryPublishingJob(owner, jobId, fingerprint);

    expect(result.variantId).toBe(variantId);

    const variant = await platformDb.postVariant.findUnique({ where: { id: variantId } });
    expect(variant?.status).toBe('SCHEDULED');
  });

  it('keeps the previous error so the reason survives the retry', async () => {
    await retryPublishingJob(owner, jobId, fingerprint);

    const variant = await platformDb.postVariant.findUnique({ where: { id: variantId } });
    // Clearing it would erase why it failed before anyone read it.
    expect(JSON.stringify(variant?.lastError)).toContain('PROVIDER_VALIDATION_ERROR');
  });

  it('refuses to retry a parked publish', async () => {
    // The important one: retrying on an unknown outcome is the guess the whole
    // design forbids. It has to go through `/resolve` first.
    const { jobId: parkedJob } = await seed({
      variantStatus: 'NEEDS_REVIEW',
      jobState: 'DEAD_LETTER',
      errorCode: 'PUBLISHING_TIMEOUT',
    });

    await expect(retryPublishingJob(owner, parkedJob, fingerprint)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('refuses to retry a published account', async () => {
    const { jobId: doneJob } = await seed({
      variantStatus: 'PUBLISHED',
      jobState: 'SUCCEEDED',
    });

    await expect(retryPublishingJob(owner, doneJob, fingerprint)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('refuses to retry one that is currently publishing', async () => {
    const { jobId: runningJob } = await seed({
      variantStatus: 'PUBLISHING',
      jobState: 'QUEUED',
    });

    await expect(retryPublishingJob(owner, runningJob, fingerprint)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('refuses another tenant job', async () => {
    await expect(retryPublishingJob(ownerB, jobId, fingerprint)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('audits the retry', async () => {
    await retryPublishingJob(owner, jobId, fingerprint);

    const entry = await platformDb.auditLog.findFirst({
      where: { organizationId: ORG, action: 'post_variant.publish_retried' },
    });
    expect(entry).not.toBeNull();
  });
});

// ── RBAC ────────────────────────────────────────────────────────────────────

describe('permissions', () => {
  it('does not let a Content Creator retry a publish', async () => {
    const { assertCan } = await import('@orbit/rbac');

    expect(() => {
      assertCan(creator, 'post:retry_failed', {
        workspaceId: WS,
        brandId: BRAND,
        intent: 'TRANSITION',
      });
    }).toThrow(ForbiddenError);
  });

  it('lets an Owner retry a publish', async () => {
    const { can } = await import('@orbit/rbac');

    expect(
      can(owner, 'post:retry_failed', { workspaceId: WS, brandId: BRAND, intent: 'TRANSITION' }),
    ).toBe(true);
  });

  it('lets a Content Creator read the logs for their own workspace', async () => {
    // Reading is not deciding: seeing why a post failed is part of writing.
    const page = await listPublishingJobs(creator);
    expect(page.jobs.length).toBeGreaterThan(0);
  });
});
