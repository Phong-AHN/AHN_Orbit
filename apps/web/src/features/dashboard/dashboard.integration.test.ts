import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock, setClock, type TenantContext } from '@orbit/core';
import { devIdentityProvider, resolveTenantContext, resolveUser } from '@orbit/auth';
import { platformDb } from '@orbit/db';
import { dashboardSummary } from './service';

/**
 * The dashboard against the real database (SRS §20, T1.17).
 *
 * Two properties matter here beyond "the numbers are right":
 *
 *  1. **Counts respect RBAC scope.** An Account Manager's dashboard must count
 *     their clients and nobody else's — a dashboard is otherwise a way to learn
 *     the shape of workspaces you cannot open.
 *  2. **No N+1.** Asserted by running the same call against two workspaces and
 *     then six and requiring the query count to be *identical*. That tests the
 *     property the DoD actually asks for, rather than pinning a magic number
 *     that changes whenever a section is added.
 */

const ORG = '018ff900-0000-7000-8000-0000f9000001';
const ORG_B = '018ffa10-0000-7000-8000-0000fa100001';

const WS_ONE = '018ff900-0000-7000-8000-0000f9000002';
const WS_TWO = '018ff900-0000-7000-8000-0000f9000003';
const BRAND_ONE = '018ff900-0000-7000-8000-0000f9000004';
const BRAND_TWO = '018ff900-0000-7000-8000-0000f9000005';
const ACCOUNT_ONE = '018ff900-0000-7000-8000-0000f9000006';
const ACCOUNT_TWO = '018ff900-0000-7000-8000-0000f9000007';

const OWNER = '018ff900-0000-7000-8000-0000f9000010';
const MANAGER = '018ff900-0000-7000-8000-0000f9000011';
const CREATOR = '018ff900-0000-7000-8000-0000f9000012';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const DAY = 86_400_000;

let ownerCtx: TenantContext;
let managerCtx: TenantContext;
let creatorCtx: TenantContext;
let restoreClock: (() => void) | undefined;

/** Extra workspaces created only by the N+1 test, cleaned up after it. */
const EXTRA_WORKSPACES = [
  '018ff900-0000-7000-8000-0000f9000020',
  '018ff900-0000-7000-8000-0000f9000021',
  '018ff900-0000-7000-8000-0000f9000022',
  '018ff900-0000-7000-8000-0000f9000023',
];

async function contextFor(email: string, organizationId = ORG): Promise<TenantContext> {
  const user = await resolveUser(await devIdentityProvider.verifyIdToken(`dev:${email}`));
  return (await resolveTenantContext(user, organizationId)).ctx;
}

async function seedPost(input: {
  id: string;
  workspaceId: string;
  brandId: string;
  status: string;
  scheduledFor?: Date;
  publishedAt?: Date;
}) {
  await platformDb.post.create({
    data: {
      id: input.id,
      organizationId: ORG,
      workspaceId: input.workspaceId,
      brandId: input.brandId,
      body: 'A perfectly ordinary announcement.',
      status: input.status as 'DRAFT',
      ...(input.scheduledFor ? { scheduledFor: input.scheduledFor, timezone: 'UTC' } : {}),
      ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
    },
  });
}

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG, 't17'],
    [ORG_B, 't17b'],
  ] as const) {
    await platformDb.organization.upsert({
      where: { id },
      update: {},
      create: { id, name: slug, slug, timezone: 'UTC' },
    });
  }

  for (const [id, name] of [
    [WS_ONE, 'client-one'],
    [WS_TWO, 'client-two'],
  ] as const) {
    await platformDb.workspace.upsert({
      where: { id },
      update: {},
      create: { id, organizationId: ORG, name, slug: name, timezone: 'UTC' },
    });
  }

  for (const [id, ws, name] of [
    [BRAND_ONE, WS_ONE, 'brand-one'],
    [BRAND_TWO, WS_TWO, 'brand-two'],
  ] as const) {
    await platformDb.brand.upsert({
      where: { id },
      update: {},
      create: { id, organizationId: ORG, workspaceId: ws, name, slug: name },
    });
  }

  for (const [id, name, role] of [
    [OWNER, 'owner', 'OWNER'],
    [MANAGER, 'manager', 'ACCOUNT_MANAGER'],
    [CREATOR, 'creator', 'CONTENT_CREATOR'],
  ] as const) {
    await platformDb.user.upsert({
      where: { id },
      update: {},
      create: { id, firebaseUid: `dev:${name}@t17.test`, email: `${name}@t17.test` },
    });
    await platformDb.organizationMembership.upsert({
      where: { organizationId_userId: { organizationId: ORG, userId: id } },
      update: { role, status: 'ACTIVE' },
      create: { organizationId: ORG, userId: id, role, status: 'ACTIVE' },
    });
  }

  // The manager runs client-one only; the creator contributes there too.
  for (const userId of [MANAGER, CREATOR]) {
    await platformDb.workspaceMembership.upsert({
      where: { workspaceId_userId: { workspaceId: WS_ONE, userId } },
      update: {},
      create: { organizationId: ORG, workspaceId: WS_ONE, userId, role: 'MANAGER' },
    });
  }

  ownerCtx = await contextFor('owner@t17.test');
  managerCtx = await contextFor('manager@t17.test');
  creatorCtx = await contextFor('creator@t17.test');
});

beforeEach(async () => {
  restoreClock = setClock(fixedClock(NOW));

  await platformDb.approval.deleteMany({ where: { organizationId: ORG } });
  await platformDb.postVariant.deleteMany({ where: { organizationId: ORG } });
  await platformDb.post.deleteMany({ where: { organizationId: ORG } });
  await platformDb.socialAccount.deleteMany({ where: { organizationId: ORG } });
  await platformDb.workspace.deleteMany({ where: { id: { in: EXTRA_WORKSPACES } } });
});

afterAll(async () => {
  restoreClock?.();
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG, ORG_B] } } });
  await platformDb.user.deleteMany({ where: { id: { in: [OWNER, MANAGER, CREATOR] } } });
  await platformDb.$disconnect();
});

// ── Counts ──────────────────────────────────────────────────────────────────

describe('per-client counts', () => {
  beforeEach(async () => {
    await seedPost({
      id: '018ff900-0000-7000-8000-0000f9000100',
      workspaceId: WS_ONE,
      brandId: BRAND_ONE,
      status: 'CLIENT_REVIEW',
    });
    await seedPost({
      id: '018ff900-0000-7000-8000-0000f9000101',
      workspaceId: WS_ONE,
      brandId: BRAND_ONE,
      status: 'SCHEDULED',
      scheduledFor: new Date(NOW.getTime() + DAY),
    });
    await seedPost({
      id: '018ff900-0000-7000-8000-0000f9000102',
      workspaceId: WS_TWO,
      brandId: BRAND_TWO,
      status: 'PUBLISHED',
      publishedAt: new Date(NOW.getTime() - 2 * DAY),
    });
  });

  it('groups by client without asking per client', async () => {
    const summary = await dashboardSummary(ownerCtx);

    const one = summary.workspaces.find((w) => w.id === WS_ONE);
    const two = summary.workspaces.find((w) => w.id === WS_TWO);

    expect(one?.awaitingApproval).toBe(1);
    expect(one?.scheduled).toBe(1);
    expect(two?.published).toBe(1);
  });

  it('counts published this week, and not last month', async () => {
    await seedPost({
      id: '018ff900-0000-7000-8000-0000f9000103',
      workspaceId: WS_TWO,
      brandId: BRAND_TWO,
      status: 'PUBLISHED',
      publishedAt: new Date(NOW.getTime() - 30 * DAY),
    });

    const summary = await dashboardSummary(ownerCtx);
    expect(summary.totals.publishedThisWeek).toBe(1);
  });

  it('names the next post that is actually still ahead', async () => {
    await seedPost({
      id: '018ff900-0000-7000-8000-0000f9000104',
      workspaceId: WS_ONE,
      brandId: BRAND_ONE,
      status: 'SCHEDULED',
      scheduledFor: new Date(NOW.getTime() - DAY),
    });

    const summary = await dashboardSummary(ownerCtx);

    // The one in the past is overdue, not "next out".
    expect(summary.nextPost?.id).toBe('018ff900-0000-7000-8000-0000f9000101');
  });
});

// ── RBAC scope ──────────────────────────────────────────────────────────────

describe('scope', () => {
  beforeEach(async () => {
    await seedPost({
      id: '018ff900-0000-7000-8000-0000f9000110',
      workspaceId: WS_ONE,
      brandId: BRAND_ONE,
      status: 'SCHEDULED',
      scheduledFor: new Date(NOW.getTime() + DAY),
    });
    await seedPost({
      id: '018ff900-0000-7000-8000-0000f9000111',
      workspaceId: WS_TWO,
      brandId: BRAND_TWO,
      status: 'SCHEDULED',
      scheduledFor: new Date(NOW.getTime() + DAY),
    });
  });

  it('shows an Owner every client', async () => {
    const summary = await dashboardSummary(ownerCtx);

    expect(summary.workspaces.map((w) => w.id).sort()).toEqual([WS_ONE, WS_TWO].sort());
    expect(summary.totals.scheduled).toBe(2);
  });

  it('shows an Account Manager only their own', async () => {
    const summary = await dashboardSummary(managerCtx);

    expect(summary.workspaces.map((w) => w.id)).toEqual([WS_ONE]);
    expect(summary.totals.scheduled).toBe(1);
  });

  it('does not leak the other client’s next post to a scoped role', async () => {
    await platformDb.post.deleteMany({ where: { id: '018ff900-0000-7000-8000-0000f9000110' } });

    const summary = await dashboardSummary(managerCtx);

    // The only scheduled post left belongs to a workspace they cannot reach.
    expect(summary.nextPost).toBeNull();
  });

  it('withholds account health from a role that cannot read accounts', async () => {
    await platformDb.socialAccount.create({
      data: {
        id: ACCOUNT_ONE,
        organizationId: ORG,
        workspaceId: WS_ONE,
        brandId: BRAND_ONE,
        platform: 'FACEBOOK',
        externalId: 'ext-dash',
        displayName: 'Acme Bakery',
        accountType: 'PAGE',
        status: 'NEEDS_RECONNECT',
      },
    });

    const owner = await dashboardSummary(ownerCtx);
    expect(owner.accountHealth?.needsReconnect).toBe(1);

    // A Content Creator's `social_account:read` is workspace-scoped, and the
    // dashboard asks for it unscoped — so the section is omitted rather than
    // guessed at.
    const creator = await dashboardSummary(creatorCtx);
    expect(creator.accountHealth).toBeNull();
    expect(creator.alerts.some((a) => a.kind === 'ACCOUNT_NEEDS_RECONNECT')).toBe(false);
  });
});

// ── Alerts ──────────────────────────────────────────────────────────────────

describe('alerts', () => {
  it('is quiet when nothing is wrong', async () => {
    const summary = await dashboardSummary(ownerCtx);
    expect(summary.alerts).toEqual([]);
  });

  it('raises a blocking alert for a broken account', async () => {
    await platformDb.socialAccount.create({
      data: {
        id: ACCOUNT_ONE,
        organizationId: ORG,
        workspaceId: WS_ONE,
        brandId: BRAND_ONE,
        platform: 'FACEBOOK',
        externalId: 'ext-dash',
        displayName: 'Acme Bakery',
        accountType: 'PAGE',
        status: 'NEEDS_RECONNECT',
        healthError: 'The token was revoked.',
      },
    });

    const summary = await dashboardSummary(ownerCtx);
    const alert = summary.alerts.find((a) => a.kind === 'ACCOUNT_NEEDS_RECONNECT');

    expect(alert?.severity).toBe('CRITICAL');
    expect(alert?.count).toBe(1);
    expect(alert?.detail).toContain('Acme Bakery');
  });

  it('raises alerts for parked and failed publishes', async () => {
    await seedPost({
      id: '018ff900-0000-7000-8000-0000f9000120',
      workspaceId: WS_ONE,
      brandId: BRAND_ONE,
      status: 'FAILED',
    });
    // Two accounts, because a post has at most one variant per account
    // (`@@unique([postId, socialAccountId])`, decision D-006). This is also the
    // realistic shape: one post to two Pages, one parked and one failed.
    for (const [id, name] of [
      [ACCOUNT_ONE, 'Acme Bakery'],
      [ACCOUNT_TWO, 'Acme Cafe'],
    ] as const) {
      await platformDb.socialAccount.create({
        data: {
          id,
          organizationId: ORG,
          workspaceId: WS_ONE,
          brandId: BRAND_ONE,
          platform: 'FACEBOOK',
          externalId: `ext-${name}`,
          displayName: name,
          accountType: 'PAGE',
          status: 'ACTIVE',
        },
      });
    }

    for (const [id, accountId, status] of [
      ['018ff900-0000-7000-8000-0000f9000130', ACCOUNT_ONE, 'NEEDS_REVIEW'],
      ['018ff900-0000-7000-8000-0000f9000131', ACCOUNT_TWO, 'FAILED'],
    ] as const) {
      await platformDb.postVariant.create({
        data: {
          id,
          organizationId: ORG,
          postId: '018ff900-0000-7000-8000-0000f9000120',
          socialAccountId: accountId,
          platform: 'FACEBOOK',
          body: '',
          status,
        },
      });
    }

    const summary = await dashboardSummary(ownerCtx);

    expect(summary.alerts.find((a) => a.kind === 'PUBLISH_NEEDS_REVIEW')?.count).toBe(1);
    expect(summary.alerts.find((a) => a.kind === 'PUBLISH_FAILED')?.count).toBe(1);
    // The parked one outranks the failed one: nothing automated will touch it.
    expect(summary.alerts[0]?.kind).toBe('PUBLISH_NEEDS_REVIEW');
  });

  it('treats a fresh review as a queue and an old one as a backlog', async () => {
    await seedPost({
      id: '018ff900-0000-7000-8000-0000f9000140',
      workspaceId: WS_ONE,
      brandId: BRAND_ONE,
      status: 'INTERNAL_REVIEW',
    });

    await platformDb.approval.create({
      data: {
        organizationId: ORG,
        postId: '018ff900-0000-7000-8000-0000f9000140',
        stage: 'INTERNAL',
        state: 'PENDING',
        requestedAt: new Date(NOW.getTime() - 60_000),
      },
    });

    const fresh = await dashboardSummary(ownerCtx);
    expect(fresh.alerts.some((a) => a.kind === 'APPROVAL_BACKLOG')).toBe(false);
    // Still counted in the headline figure — it is pending, just not overdue.
    expect(fresh.totals.awaitingApproval).toBe(1);

    await platformDb.approval.updateMany({
      where: { postId: '018ff900-0000-7000-8000-0000f9000140' },
      data: { requestedAt: new Date(NOW.getTime() - 3 * DAY) },
    });

    const stale = await dashboardSummary(ownerCtx);
    const alert = stale.alerts.find((a) => a.kind === 'APPROVAL_BACKLOG');
    expect(alert?.count).toBe(1);
    expect(alert?.detail).toContain('3 days');
  });

  it('raises an overdue alert only once a post is properly late', async () => {
    await seedPost({
      id: '018ff900-0000-7000-8000-0000f9000150',
      workspaceId: WS_ONE,
      brandId: BRAND_ONE,
      status: 'SCHEDULED',
      scheduledFor: new Date(NOW.getTime() - DAY),
    });
    await platformDb.socialAccount.create({
      data: {
        id: ACCOUNT_ONE,
        organizationId: ORG,
        workspaceId: WS_ONE,
        brandId: BRAND_ONE,
        platform: 'FACEBOOK',
        externalId: 'ext-dash',
        displayName: 'Acme Bakery',
        accountType: 'PAGE',
        status: 'ACTIVE',
      },
    });
    await platformDb.postVariant.create({
      data: {
        organizationId: ORG,
        postId: '018ff900-0000-7000-8000-0000f9000150',
        socialAccountId: ACCOUNT_ONE,
        platform: 'FACEBOOK',
        body: '',
        status: 'SCHEDULED',
        scheduledFor: new Date(NOW.getTime() - DAY),
      },
    });

    const summary = await dashboardSummary(ownerCtx);
    expect(summary.alerts.find((a) => a.kind === 'SCHEDULE_OVERDUE')?.count).toBe(1);
  });
});

// ── The DoD: no N+1 ─────────────────────────────────────────────────────────

describe('aggregation', () => {
  /**
   * Count the queries one call makes.
   *
   * Prisma emits a `query` event per statement in development, which is what
   * integration tests run as. `withTenant` builds its scoped client from the
   * same underlying engine, so events fire for scoped queries too.
   */
  async function countQueries(run: () => Promise<unknown>): Promise<number> {
    let count = 0;
    const listener = () => {
      count += 1;
    };

    // `$on('query')` is only typed when the client's `log` option is a literal;
    // ours is resolved at runtime, so the cast is the honest way to reach it.
    (platformDb as unknown as { $on: (e: 'query', cb: () => void) => void }).$on('query', listener);

    await run();

    // Prisma has no `$off`; the listener stays but the count is taken here.
    return count;
  }

  it('does not issue more queries as clients are added', async () => {
    await seedPost({
      id: '018ff900-0000-7000-8000-0000f9000200',
      workspaceId: WS_ONE,
      brandId: BRAND_ONE,
      status: 'SCHEDULED',
      scheduledFor: new Date(NOW.getTime() + DAY),
    });

    const withTwo = await countQueries(() => dashboardSummary(ownerCtx));

    // Four more clients, each with content of their own.
    for (const [index, id] of EXTRA_WORKSPACES.entries()) {
      await platformDb.workspace.create({
        data: {
          id,
          organizationId: ORG,
          name: `extra-${index}`,
          slug: `extra-${index}`,
          timezone: 'UTC',
        },
      });
      await platformDb.post.create({
        data: {
          organizationId: ORG,
          workspaceId: id,
          brandId: BRAND_ONE,
          body: 'more content',
          status: 'CLIENT_REVIEW',
        },
      });
    }

    const withSix = await countQueries(() => dashboardSummary(ownerCtx));

    // Six clients confirmed present, so the comparison is meaningful.
    const summary = await dashboardSummary(ownerCtx);
    expect(summary.workspaces).toHaveLength(6);

    // Guard against the test passing vacuously: if no query events reached the
    // listener, `0 === 0` would "prove" the property while measuring nothing.
    expect(withTwo).toBeGreaterThan(0);

    // The property the DoD asks for: the cost does not scale with the number of
    // clients. A per-workspace count would have made this four higher.
    expect(withSix).toBe(withTwo);
  });
});
