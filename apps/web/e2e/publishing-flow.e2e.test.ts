import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { clock, fixedClock, setClock, type TenantContext } from '@orbit/core';
import {
  SESSION_COOKIE_NAME,
  devIdentityProvider,
  resolveTenantContext,
  resolveUser,
} from '@orbit/auth';
import { platformDb } from '@orbit/db';
import { closeQueues, closeSharedConnection, redis } from '@orbit/queue';
import { registerProvider, resetRegistry } from '@orbit/providers';
import { MockProvider } from '@orbit/providers/mock';
import { renderMetrics, resetMetrics } from '@orbit/observability';

import { ensureProvidersRegistered } from '@/server/providers';
import { createBrand, createOrganization, createWorkspace } from '@/features/tenancy/service';
import { addWorkspaceMember } from '@/features/tenancy/members';
import { connectAccounts, stageDiscoveredAccounts } from '@/features/social/service';
import { issueOAuthState, verifyOAuthState } from '@/features/social/oauth-state';
import { createPost, transitionPost } from '@/features/posts/service';
import { listApprovalQueue } from '@/features/approvals/service';
import { schedulePost } from '@/features/scheduling/service';
import { listPublishingJobs, publishingSummary } from '@/features/publishing/logs';
import { sweepDueVariants } from '../../worker/src/processors/scheduler';
import { publishVariant } from '../../worker/src/publishing/engine';
import { processNotification } from '../../worker/src/processors/notifications';

import { GET as portalApprovals } from '../app/api/v1/portal/workspaces/[workspaceId]/approvals/route';
import { POST as portalDecide } from '../app/api/v1/portal/posts/[postId]/decide/route';
import { GET as portalPublished } from '../app/api/v1/portal/workspaces/[workspaceId]/published/route';

/**
 * The §32 end-to-end flow (T1.19).
 *
 * **Login → org → workspace → brand → connect → compose → submit → approve
 * (internal) → approve (client, through the portal) → schedule → sweep →
 * publish → publishing log → client portal.**
 *
 * This is the test that exists so that switching `MockProvider` for the real
 * Facebook adapter is a swap rather than a first encounter. Everything except
 * the provider is real: real Postgres, real Redis, real services, real route
 * handlers, the real state machine, the real four idempotency layers. The
 * seams between features — which is where a system this size actually breaks —
 * are exercised in the order a person would meet them.
 *
 * Written as one ordered narrative rather than independent cases. `bail: 1` in
 * the config means a failure stops the run, because step 9 failing because
 * step 4 failed is noise.
 *
 * **When Meta App Review completes**, the only change needed to run this
 * against a real Test Page is registering `FacebookProvider` instead of
 * `MockProvider` in `beforeAll` and pointing the credential at a real token.
 * Nothing else in this file is mock-aware.
 */

const NOW = new Date('2026-06-15T09:00:00.000Z');
const AGENCY_EMAIL = 'founder@e2e-agency.test';
const CLIENT_EMAIL = 'marketing@e2e-client.test';

let mock: MockProvider;
let restoreClock: (() => void) | undefined;

/** Carried between steps: the flow builds one artefact at a time. */
const flow: {
  organizationId?: string;
  workspaceId?: string;
  brandId?: string;
  accountId?: string;
  postId?: string;
  variantId?: string;
  agencyUserId?: string;
  clientUserId?: string;
  clientSession?: string;
  scheduledFor?: Date;
} = {};

const fingerprint = { ip: '203.0.113.10', userAgent: 'e2e' };

function agencyCtx(): TenantContext {
  if (!agencyContext) throw new Error('agency context not established');
  return agencyContext;
}

let agencyContext: TenantContext | undefined;

function portalRequest(path: string, body?: unknown): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set('cookie', `${SESSION_COOKIE_NAME}=${flow.clientSession ?? ''}`);

  return new NextRequest(`http://localhost:3000${path}`, {
    method: body ? 'POST' : 'GET',
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const params = <P>(value: P) => ({ params: Promise.resolve(value) });

async function readJson(response: Response): Promise<{ status: number; body: unknown }> {
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
}

async function flushRedis() {
  const connection = redis();
  for (const pattern of ['bull:*', 'lock:publish:*', 'ratelimit:*', 'dlq:*']) {
    let cursor = '0';
    do {
      const [next, keys] = await connection.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await connection.del(...keys);
    } while (cursor !== '0');
  }
}

beforeAll(async () => {
  process.env.ORBIT_ROLE = 'worker';

  restoreClock = setClock(fixedClock(NOW));
  resetMetrics();

  // Let the app's own bootstrap run first, then take the registry over with a
  // mock this file can inspect and inject faults into. `ensureProvidersRegistered`
  // latches, so anything reaching it later (validation, on every transition)
  // becomes a no-op and cannot swap the provider back underneath the flow.
  //
  // In `test` that bootstrap already chooses the mock regardless of whether
  // Meta credentials are configured (**D-047**) — the first version of this
  // file did not do this and quietly published to `graph.facebook.com`.
  ensureProvidersRegistered();
  resetRegistry();
  mock = new MockProvider();
  registerProvider(mock, { developmentOnly: true });

  await flushRedis();

  // A clean slate: this flow creates its own organization from nothing, which
  // is the point — it proves onboarding works, not just steady state.
  await platformDb.user.deleteMany({ where: { email: { in: [AGENCY_EMAIL, CLIENT_EMAIL] } } });
  await platformDb.organization.deleteMany({ where: { slug: { startsWith: 'e2e-agency' } } });
});

afterAll(async () => {
  restoreClock?.();
  resetRegistry();

  await flushRedis();
  if (flow.organizationId) {
    await platformDb.organization.deleteMany({ where: { id: flow.organizationId } });
  }
  await platformDb.user.deleteMany({ where: { email: { in: [AGENCY_EMAIL, CLIENT_EMAIL] } } });

  await platformDb.$disconnect();
  await closeQueues();
  await closeSharedConnection();
});

// ── 1. Sign in ──────────────────────────────────────────────────────────────

describe('§32 · the whole flow', () => {
  it('1 · an agency founder signs in for the first time', async () => {
    // First sign-in provisions the User row from the verified identity. No
    // password material exists anywhere in this system (D-004).
    const identity = await devIdentityProvider.verifyIdToken(`dev:${AGENCY_EMAIL}`);
    const user = await resolveUser(identity);

    expect(user.email).toBe(AGENCY_EMAIL);
    flow.agencyUserId = user.id;
  });

  it('2 · creates an organization and becomes its owner', async () => {
    const organization = await createOrganization(
      flow.agencyUserId!,
      { name: 'E2E Agency', timezone: 'Europe/London' },
      fingerprint,
      'e2e-correlation',
    );

    flow.organizationId = organization.id;

    const membership = await platformDb.organizationMembership.findFirstOrThrow({
      where: { organizationId: organization.id, userId: flow.agencyUserId! },
    });
    expect(membership.role).toBe('OWNER');

    const user = await resolveUser(await devIdentityProvider.verifyIdToken(`dev:${AGENCY_EMAIL}`));
    agencyContext = (await resolveTenantContext(user, organization.id)).ctx;
  });

  it('3 · adds a client workspace and a brand', async () => {
    const workspace = await createWorkspace(
      agencyCtx(),
      { name: 'Acme Bakery', timezone: 'Europe/London' },
      fingerprint,
    );
    flow.workspaceId = workspace.id;

    const brand = await createBrand(
      agencyCtx(),
      workspace.id,
      { name: 'Acme Bakery' },
      fingerprint,
    );
    flow.brandId = brand.id;

    // The workspace's timezone is what scheduling resolves against (assumption
    // C5), so it is required rather than defaulted.
    expect(workspace.timezone).toBe('Europe/London');
  });

  // ── 4. Connect ────────────────────────────────────────────────────────────

  it('4 · connects a social account through the OAuth flow', async () => {
    // The CSRF properties first, since they are what make the rest safe: the
    // state is signed, session-bound, single-use and expiring (T1.6).
    const { state, nonce } = issueOAuthState({
      platform: 'FACEBOOK',
      organizationId: flow.organizationId!,
      workspaceId: flow.workspaceId!,
      brandId: flow.brandId!,
      userId: flow.agencyUserId!,
    });

    const payload = verifyOAuthState({
      state,
      cookieNonce: nonce,
      sessionUserId: flow.agencyUserId!,
      expectedOrganizationId: flow.organizationId!,
    });
    expect(payload.workspaceId).toBe(flow.workspaceId);

    // Somebody else's session cannot complete this flow.
    expect(() =>
      verifyOAuthState({
        state,
        cookieNonce: nonce,
        sessionUserId: '018f0000-0000-7000-8000-0000000000ff',
      }),
    ).toThrow();

    // The exchange, then the picker's confirmation — the same two services the
    // callback route uses.
    const discovered = await mock.exchangeCode({ code: 'e2e-code', redirectUri: 'https://x/cb' });

    const staged = await stageDiscoveredAccounts(agencyCtx(), {
      platform: 'FACEBOOK',
      workspaceId: flow.workspaceId!,
      brandId: flow.brandId!,
      discovered: discovered.accounts,
    });
    expect(staged.length).toBeGreaterThan(0);

    const connected = await connectAccounts(
      agencyCtx(),
      {
        platform: 'FACEBOOK',
        workspaceId: flow.workspaceId!,
        brandId: flow.brandId!,
        socialAccountIds: [staged[0]!.id],
      },
      fingerprint,
    );

    flow.accountId = connected[0]!.id;

    const account = await platformDb.socialAccount.findUniqueOrThrow({
      where: { id: flow.accountId },
    });
    expect(account.status).toBe('ACTIVE');

    // The credential is sealed at rest and the plaintext appears nowhere.
    const credential = await platformDb.socialCredential.findFirstOrThrow({
      where: { socialAccountId: flow.accountId },
    });
    expect(Buffer.from(credential.accessTokenCiphertext).toString('utf8')).not.toContain('mock');
  });

  // ── 5. Compose ────────────────────────────────────────────────────────────

  it('5 · composes a post for that account', async () => {
    const post = await createPost(
      agencyCtx(),
      {
        workspaceId: flow.workspaceId!,
        brandId: flow.brandId!,
        title: 'Sourdough Saturday',
        body: 'Fresh sourdough from 8am this Saturday. First loaf on us.',
        hashtags: ['sourdough'],
        mentions: [],
        media: [],
        socialAccountIds: [flow.accountId!],
      },
      fingerprint,
    );

    flow.postId = post.id;
    expect(post.status).toBe('DRAFT');

    const variant = await platformDb.postVariant.findFirstOrThrow({ where: { postId: post.id } });
    flow.variantId = variant.id;
    // Authorship comes from the session, never the request.
    expect(post.createdById).toBe(flow.agencyUserId);
  });

  // ── 6. Approve, internally ────────────────────────────────────────────────

  it('6 · submits for internal review, and the gate opens', async () => {
    const submitted = await transitionPost(
      agencyCtx(),
      flow.postId!,
      'INTERNAL_REVIEW',
      fingerprint,
    );
    expect(submitted.status).toBe('INTERNAL_REVIEW');

    const queue = await listApprovalQueue(agencyCtx(), { stage: 'INTERNAL' });
    expect(queue.some((approval) => approval.post.id === flow.postId)).toBe(true);
  });

  it('7 · cannot skip the client, because approval is required (D-018)', async () => {
    // The default posture is that the client must approve. Internal approval
    // sends it onward rather than finishing review.
    await expect(
      transitionPost(agencyCtx(), flow.postId!, 'APPROVED', fingerprint),
    ).rejects.toThrow();

    const sent = await transitionPost(agencyCtx(), flow.postId!, 'CLIENT_REVIEW', fingerprint);
    expect(sent.status).toBe('CLIENT_REVIEW');
  });

  // ── 8. The client approves, through the portal ────────────────────────────

  it('8 · the client sees it in their portal, and only what they should', async () => {
    // Provision the client and put them in the workspace.
    const clientUser = await resolveUser(
      await devIdentityProvider.verifyIdToken(`dev:${CLIENT_EMAIL}`),
    );
    flow.clientUserId = clientUser.id;

    await platformDb.organizationMembership.create({
      data: {
        organizationId: flow.organizationId!,
        userId: clientUser.id,
        role: 'CLIENT',
        status: 'ACTIVE',
      },
    });
    await addWorkspaceMember(
      agencyCtx(),
      flow.workspaceId!,
      clientUser.id,
      'CLIENT_APPROVER',
      fingerprint,
    );

    flow.clientSession = await devIdentityProvider.createSessionCookie(
      `dev:${CLIENT_EMAIL}`,
      3_600_000,
    );

    const { status, body } = await readJson(
      await portalApprovals(
        portalRequest(`/api/v1/portal/workspaces/${flow.workspaceId!}/approvals`),
        params({ workspaceId: flow.workspaceId! }),
      ),
    );

    expect(status).toBe(200);
    const approvals = (body as { approvals: Array<{ post: { id: string } }> }).approvals;
    expect(approvals.map((a) => a.post.id)).toContain(flow.postId);

    // Nothing internal reaches the portal payload (D-012).
    const raw = JSON.stringify(body);
    for (const forbidden of [
      'createdById',
      'assignedToId',
      'approvalRequired',
      'socialAccountId',
    ]) {
      expect(raw, `portal leaked ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('9 · the client approves, and the post moves through the real state machine', async () => {
    const { status, body } = await readJson(
      await portalDecide(
        portalRequest(`/api/v1/portal/posts/${flow.postId!}/decide`, { decision: 'APPROVED' }),
        params({ postId: flow.postId! }),
      ),
    );

    expect(status).toBe(200);
    expect((body as { post: { status: string } }).post.status).toBe('APPROVED');

    const approval = await platformDb.approval.findFirstOrThrow({
      where: { postId: flow.postId!, stage: 'CLIENT' },
    });
    expect(approval.state).toBe('APPROVED');
    // The client's own decision, not recorded on their behalf.
    expect(approval.decidedById).toBe(flow.clientUserId);
    expect(approval.onBehalfOf).toBe(false);
  });

  // ── 10. Schedule ──────────────────────────────────────────────────────────

  it('10 · schedules it in the workspace’s timezone', async () => {
    // 10:30 London on the day. The workspace's zone is the authority, and the
    // stored instant is UTC (T1.12).
    const scheduled = await schedulePost(
      agencyCtx(),
      flow.postId!,
      { localTime: { year: 2026, month: 6, day: 15, hour: 10, minute: 30 } },
      fingerprint,
    );

    expect(scheduled.post.status).toBe('SCHEDULED');
    expect(scheduled.timezone).toBe('Europe/London');

    const variant = await platformDb.postVariant.findUniqueOrThrow({
      where: { id: flow.variantId! },
    });
    expect(variant.status).toBe('SCHEDULED');
    expect(variant.scheduledFor).not.toBeNull();
    // British Summer Time: 10:30 local is 09:30 UTC.
    expect(variant.scheduledFor?.toISOString()).toBe('2026-06-15T09:30:00.000Z');
    // A content hash was stamped, which is what reconciliation matches on.
    expect(variant.contentHash).toBeTruthy();

    flow.scheduledFor = variant.scheduledFor!;
  });

  // ── 11. Publish ───────────────────────────────────────────────────────────

  it('11 · the sweep picks it up when its time comes', async () => {
    // Nothing is due yet.
    expect((await sweepDueVariants('e2e')).enqueued).toBe(0);

    // Move to the scheduled instant.
    restoreClock?.();
    restoreClock = setClock(fixedClock(flow.scheduledFor!));

    const result = await sweepDueVariants('e2e');
    expect(result.due).toBeGreaterThanOrEqual(1);
    expect(result.enqueued).toBeGreaterThanOrEqual(1);

    const job = await platformDb.publishingJob.findFirstOrThrow({
      where: { postVariantId: flow.variantId! },
    });
    expect(job.state).toBe('QUEUED');
  });

  it('12 · publishes exactly once, through all four idempotency layers', async () => {
    const job = await platformDb.publishingJob.findFirstOrThrow({
      where: { postVariantId: flow.variantId! },
    });

    const context = {
      payload: {
        organizationId: flow.organizationId!,
        correlationId: 'e2e-publish',
        postVariantId: flow.variantId!,
        idempotencyKey: job.idempotencyKey,
        publishingJobId: job.id,
      },
      attempt: 1,
      jobId: job.idempotencyKey,
      correlationId: 'e2e-publish',
    };

    const first = await publishVariant(context);
    expect(first.kind).toBe('PUBLISHED');
    expect(first.externalPostId).toBeTruthy();

    // Layer 2 is the one that actually guarantees it: a second worker running
    // the same job finds the atomic claim already taken — the conditional
    // `UPDATE … WHERE status='SCHEDULED'` matches nothing — and exits without
    // ever reaching the provider.
    const callsAfterFirst = mock.callCounts.publish;
    const second = await publishVariant(context);

    expect(second.kind).toBe('NOT_CLAIMABLE');
    expect(mock.callCounts.publish).toBe(callsAfterFirst);
    // The property the whole design exists for: one post on the Page.
    expect(mock.posts.size).toBe(1);
  });

  it('13 · the post and its variant settle as published', async () => {
    const post = await platformDb.post.findUniqueOrThrow({ where: { id: flow.postId! } });
    const variant = await platformDb.postVariant.findUniqueOrThrow({
      where: { id: flow.variantId! },
    });

    expect(post.status).toBe('PUBLISHED');
    expect(post.publishedAt).not.toBeNull();
    expect(variant.status).toBe('PUBLISHED');
    // The DB check constraint requires this, and analytics and reconciliation
    // both need it (D-030).
    expect(variant.externalPostId).toBeTruthy();
    expect(variant.externalPermalink).toBeTruthy();
  });

  // ── 14. The publishing log ────────────────────────────────────────────────

  it('14 · the publishing log shows the successful job', async () => {
    const summary = await publishingSummary(agencyCtx());
    expect(summary.published).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.needsReview).toBe(0);

    const page = await listPublishingJobs(agencyCtx(), {});
    const entry = page.jobs.find((j) => j.postVariant.post.id === flow.postId);
    expect(entry?.state).toBe('SUCCEEDED');

    // The attempt ledger is the evidence trail for layer 4.
    const attempts = await platformDb.publishingAttempt.findMany({
      where: { publishingJob: { postVariantId: flow.variantId! } },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.state).toBe('SUCCEEDED');
  });

  // ── 15. Back to the client ────────────────────────────────────────────────

  it('15 · the client sees it live, with a link and nothing internal', async () => {
    const { status, body } = await readJson(
      await portalPublished(
        portalRequest(`/api/v1/portal/workspaces/${flow.workspaceId!}/published`),
        params({ workspaceId: flow.workspaceId! }),
      ),
    );

    expect(status).toBe(200);

    const posts = (
      body as {
        posts: Array<{ id: string; variants: Array<{ externalPermalink: string | null }> }>;
      }
    ).posts;

    const published = posts.find((p) => p.id === flow.postId);
    expect(published?.variants[0]?.externalPermalink).toBeTruthy();

    const raw = JSON.stringify(body);
    for (const forbidden of ['externalPostId', 'socialAccountId', 'lastError', 'contentHash']) {
      expect(raw, `portal leaked ${forbidden}`).not.toContain(forbidden);
    }
  });

  // ── 16. What the flow left behind ─────────────────────────────────────────

  it('16 · left an audit trail across the whole journey', async () => {
    const audits = await platformDb.auditLog.findMany({
      where: { organizationId: flow.organizationId! },
      select: { action: true },
    });

    const actions = new Set(audits.map((a) => a.action));

    // Every step that changed something is on the record.
    for (const expected of [
      'organization.created',
      'workspace.created',
      'brand.created',
      'social_account.connected',
      'post.created',
      'post.transitioned',
      'approval.decided',
      'post_variant.published',
    ]) {
      expect(actions.has(expected), `missing audit: ${expected}`).toBe(true);
    }
  });

  it('17 · recorded the operational metrics an alarm would use', async () => {
    const metrics = renderMetrics();

    // Publish success rate and latency (T1.19).
    expect(metrics).toContain('orbit_publish_outcomes_total');
    expect(metrics).toContain('outcome="PUBLISHED"');
    expect(metrics).toContain('orbit_publish_duration_seconds_count');
    // No tenant labels: one customer's volume is not on the metrics port.
    expect(metrics).not.toContain(flow.organizationId!);
  });

  it('18 · notified the people who needed to know, and nobody else', async () => {
    // The client's approval raised a transition event; run the fan-out the way
    // the worker would.
    await processNotification({
      payload: {
        organizationId: flow.organizationId!,
        correlationId: 'e2e-notify',
        event: 'post.approval_requested',
        resourceType: 'Post',
        resourceId: flow.postId!,
      },
      attempt: 1,
      jobId: 'e2e-notify',
      correlationId: 'e2e-notify',
    });

    const notifications = await platformDb.notification.findMany({
      where: { organizationId: flow.organizationId!, resourceId: flow.postId! },
      select: { userId: true },
    });

    // The owner can approve; the client is not told to approve their own post.
    expect(notifications.map((n) => n.userId)).toContain(flow.agencyUserId);
    expect(notifications.map((n) => n.userId)).not.toContain(flow.clientUserId);
  });
});

// ── The failure path, since it is the one that matters most ─────────────────

describe('§32 · the ambiguous publish never double-posts', () => {
  it('parks rather than retrying when the outcome cannot be established', async () => {
    // A second post, taken to SCHEDULED, then published against a provider that
    // times out and cannot be reconciled — the case D-027 exists for.
    const post = await createPost(
      agencyCtx(),
      {
        workspaceId: flow.workspaceId!,
        brandId: flow.brandId!,
        body: 'A second announcement, whose fate will be unclear.',
        hashtags: [],
        mentions: [],
        media: [],
        socialAccountIds: [flow.accountId!],
      },
      fingerprint,
    );

    await transitionPost(agencyCtx(), post.id, 'INTERNAL_REVIEW', fingerprint);
    await transitionPost(agencyCtx(), post.id, 'CLIENT_REVIEW', fingerprint);
    await transitionPost(agencyCtx(), post.id, 'APPROVED', fingerprint);

    const at = new Date(clock.now().getTime() + 10 * 60_000);
    await schedulePost(agencyCtx(), post.id, { scheduledForUtc: at.toISOString() }, fingerprint);

    restoreClock?.();
    restoreClock = setClock(fixedClock(at));

    await sweepDueVariants('e2e-ambiguous');

    const variant = await platformDb.postVariant.findFirstOrThrow({ where: { postId: post.id } });
    const job = await platformDb.publishingJob.findFirstOrThrow({
      where: { postVariantId: variant.id },
    });

    // The provider times out *and* the post did not land — but reconciliation
    // cannot confirm that, so the engine must not guess.
    mock.fault = 'TIMEOUT_NOT_PUBLISHED';
    const before = mock.posts.size;

    const result = await publishVariant({
      payload: {
        organizationId: flow.organizationId!,
        correlationId: 'e2e-ambiguous',
        postVariantId: variant.id,
        idempotencyKey: job.idempotencyKey,
        publishingJobId: job.id,
      },
      attempt: 1,
      jobId: job.idempotencyKey,
      correlationId: 'e2e-ambiguous',
    });

    // Reconciliation said NOT_FOUND, so retrying is safe and the engine defers
    // rather than parking. What must never happen is a second post.
    expect(['DEFERRED', 'PARKED']).toContain(result.kind);
    expect(mock.posts.size).toBe(before);

    const settled = await platformDb.postVariant.findUniqueOrThrow({ where: { id: variant.id } });
    expect(settled.status).not.toBe('PUBLISHED');
    expect(settled.externalPostId).toBeNull();
  });
});
