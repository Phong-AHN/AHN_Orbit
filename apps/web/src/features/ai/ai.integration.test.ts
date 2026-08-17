import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  NotFoundError,
  PlanLimitExceededError,
  RateLimitedError,
  fixedClock,
  setClock,
  type TenantContext,
} from '@orbit/core';
import { devIdentityProvider, resolveTenantContext, resolveUser } from '@orbit/auth';
import { platformDb } from '@orbit/db';
import { closeQueues, closeSharedConnection, redis } from '@orbit/queue';
import { MockAIProvider } from '@orbit/ai';
import { updateBrandVoice } from '@/features/brand-voice/service';
import { getCreditStatus, runGeneration } from './service';

/**
 * Metering, grounding and isolation for AI (T4.3).
 *
 * The mock provider throughout: no key, no network, no spend (**D-049**). What
 * is under test is everything *around* the model — the credit ceiling, the
 * usage trail, and above all that a generation for one brand can only ever be
 * grounded in that brand's own material (SRS §24).
 */

const ORG_A = '018f0d00-0000-7000-8000-000d00000001';
const ORG_B = '018f0e00-0000-7000-8000-000e00000001';
const WS_A = '018f0d00-0000-7000-8000-000d00000002';
const WS_B = '018f0e00-0000-7000-8000-000e00000002';
const BRAND_A = '018f0d00-0000-7000-8000-000d00000003';
const BRAND_A2 = '018f0d00-0000-7000-8000-000d00000004';
const BRAND_B = '018f0e00-0000-7000-8000-000e00000003';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const fingerprint = { ip: '127.0.0.1', userAgent: 'vitest' };

let ctxA: TenantContext;
let ctxB: TenantContext;
let restoreClock: (() => void) | undefined;

const provider = new MockAIProvider();

async function seed(org: string, ws: string, brands: string[], slug: string, email: string) {
  await platformDb.organization.upsert({
    where: { id: org },
    update: {},
    create: {
      id: org,
      name: slug,
      slug,
      timezone: 'UTC',
      subscription: {
        create: { plan: 'trial', status: 'TRIALING', seats: 5, limits: { aiCreditsPerMonth: 3 } },
      },
    },
  });
  await platformDb.workspace.upsert({
    where: { id: ws },
    update: {},
    create: { id: ws, organizationId: org, name: slug, slug, timezone: 'UTC' },
  });

  for (const [index, brand] of brands.entries()) {
    await platformDb.brand.upsert({
      where: { id: brand },
      update: {},
      create: {
        id: brand,
        organizationId: org,
        workspaceId: ws,
        name: `${slug}-brand-${index}`,
        slug: `${slug}-brand-${index}`,
      },
    });
  }

  const identity = await devIdentityProvider.verifyIdToken(`dev:${email}`);
  const user = await resolveUser(identity);

  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: org, userId: user.id } },
    update: {},
    create: { organizationId: org, userId: user.id, role: 'OWNER', status: 'ACTIVE' },
  });

  const { ctx } = await resolveTenantContext(user, org, 'itest-ai');
  return ctx;
}

beforeAll(async () => {
  ctxA = await seed(ORG_A, WS_A, [BRAND_A, BRAND_A2], 'ai-a', 'owner@ai-a.test');
  ctxB = await seed(ORG_B, WS_B, [BRAND_B], 'ai-b', 'owner@ai-b.test');
});

afterAll(async () => {
  restoreClock?.();
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await platformDb.user.deleteMany({ where: { email: { endsWith: '.test' } } });
  await closeQueues();
  await closeSharedConnection();
});

async function flushRateLimits() {
  const connection = redis();
  let cursor = '0';
  do {
    const [next, keys] = await connection.scan(cursor, 'MATCH', 'ratelimit:ai:*', 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) await connection.del(...keys);
  } while (cursor !== '0');
}

beforeEach(async () => {
  restoreClock?.();
  restoreClock = setClock(fixedClock(NOW));

  // Buckets are real Redis state and survive between tests otherwise, which
  // would make the credit tests fail for the wrong reason.
  await flushRateLimits();

  await platformDb.aIUsage.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.brandVoice.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
});

function caption(ctx: TenantContext, brandId: string, intent = 'A new blend') {
  return runGeneration(
    { ctx, brandId, operation: 'caption', correlationId: 'corr-1' },
    provider,
    (brand) => provider.generateCaption({ brand, intent, correlationId: 'corr-1' }),
  );
}

describe('grounding', () => {
  it('works for a brand with no Brand Brain at all', async () => {
    const result = await caption(ctxA, BRAND_A);

    expect(result.value).toContain('A new blend');
  });

  it('grounds in the brand own material once it exists', async () => {
    await updateBrandVoice(ctxA, BRAND_A, { companyDescription: 'A roastery.' }, fingerprint);

    const result = await caption(ctxA, BRAND_A);

    // The mock names the brand it was given, which is enough to prove the
    // context reached the call.
    expect(result.value).toContain('ai-a-brand-0');
  });

  /**
   * The §24 guarantee. Two brands in the *same* organization must not share
   * context — tenant isolation alone would not catch this, because both are
   * legitimately visible to this principal.
   */
  it('never grounds one brand in another brand material, even inside one organization', async () => {
    await updateBrandVoice(
      ctxA,
      BRAND_A,
      { bannedTerms: ['forbidden'], companyDescription: 'Brand one.' },
      fingerprint,
    );
    // The second brand has its own Brand Brain, and no banned terms in it.
    await updateBrandVoice(ctxA, BRAND_A2, { companyDescription: 'Brand two.' }, fingerprint);

    // The *other* brand has no banned terms, so a suggestion containing the
    // word must not be flagged — if brand one's list leaked, it would be.
    const result = await runGeneration(
      { ctx: ctxA, brandId: BRAND_A2, operation: 'caption', correlationId: 'corr-1' },
      provider,
      (brand) =>
        provider.generateCaption({ brand, intent: 'A forbidden idea', correlationId: 'corr-1' }),
    );

    expect(result.bannedTermHits).toEqual([]);
    expect(result.value).toContain('ai-a-brand-1');
  });

  it('refuses a brand from another tenant, by exact id', async () => {
    await expect(caption(ctxA, BRAND_B)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('flags a banned term as a warning and still returns the suggestion', async () => {
    await updateBrandVoice(ctxA, BRAND_A, { bannedTerms: ['cheap'] }, fingerprint);

    const result = await caption(ctxA, BRAND_A, 'A cheap deal');

    expect(result.bannedTermHits).toEqual(['cheap']);
    expect(result.value).toContain('cheap');
  });
});

describe('metering', () => {
  it('records a usage row per generation', async () => {
    await caption(ctxA, BRAND_A);
    await caption(ctxA, BRAND_A);

    const rows = await platformDb.aIUsage.findMany({ where: { organizationId: ORG_A } });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.operation).toBe('caption');
    expect(rows[0]?.model).toBe('mock-1');
    expect(rows[0]?.succeeded).toBe(true);
  });

  it('attributes the usage to the person who asked', async () => {
    await caption(ctxA, BRAND_A);

    const row = await platformDb.aIUsage.findFirstOrThrow({ where: { organizationId: ORG_A } });
    expect(row.userId).not.toBeNull();
  });

  /**
   * A failed call still cost a model request. A month of failures that left no
   * trace would be a month of unexplained bill.
   */
  it('records a failed generation too, marked as failed', async () => {
    await expect(
      runGeneration(
        { ctx: ctxA, brandId: BRAND_A, operation: 'caption', correlationId: 'corr-1' },
        provider,
        async () => {
          throw new Error('the model fell over');
        },
      ),
    ).rejects.toThrow('the model fell over');

    const row = await platformDb.aIUsage.findFirstOrThrow({ where: { organizationId: ORG_A } });
    expect(row.succeeded).toBe(false);
  });

  it('reports what has been used against the plan limit', async () => {
    await caption(ctxA, BRAND_A);

    const status = await getCreditStatus(ctxA);

    expect(status).toMatchObject({ used: 1, limit: 3, remaining: 2 });
  });

  it('counts one credit per request regardless of how long the text is', async () => {
    await caption(ctxA, BRAND_A, 'x'.repeat(1_500));

    expect((await getCreditStatus(ctxA)).used).toBe(1);
  });
});

describe('the credit ceiling', () => {
  it('refuses once the month allowance is gone', async () => {
    await caption(ctxA, BRAND_A);
    await caption(ctxA, BRAND_A);
    await caption(ctxA, BRAND_A);

    await expect(caption(ctxA, BRAND_A)).rejects.toBeInstanceOf(PlanLimitExceededError);
  });

  it('does not spend a credit on the request it refused', async () => {
    for (let i = 0; i < 3; i++) await caption(ctxA, BRAND_A);
    await caption(ctxA, BRAND_A).catch(() => null);

    expect(await platformDb.aIUsage.count({ where: { organizationId: ORG_A } })).toBe(3);
  });

  it('resets at the month boundary', async () => {
    for (let i = 0; i < 3; i++) await caption(ctxA, BRAND_A);
    await expect(caption(ctxA, BRAND_A)).rejects.toBeInstanceOf(PlanLimitExceededError);

    restoreClock?.();
    restoreClock = setClock(fixedClock(new Date('2026-07-01T00:00:00.000Z')));

    await expect(caption(ctxA, BRAND_A)).resolves.toBeDefined();
  });

  /**
   * One organization exhausting its allowance must not touch another's — the
   * count is scoped, and a global one would let a busy agency lock out a quiet
   * one on the same platform.
   */
  it('counts each organization separately', async () => {
    for (let i = 0; i < 3; i++) await caption(ctxA, BRAND_A);
    await expect(caption(ctxA, BRAND_A)).rejects.toBeInstanceOf(PlanLimitExceededError);

    await expect(caption(ctxB, BRAND_B)).resolves.toBeDefined();
    expect((await getCreditStatus(ctxB)).used).toBe(1);
  });

  it('never counts another tenant usage into this one', async () => {
    await caption(ctxB, BRAND_B);
    await caption(ctxB, BRAND_B);

    expect((await getCreditStatus(ctxA)).used).toBe(0);
  });
});

/**
 * Speed, as distinct from volume.
 *
 * The monthly ceiling stops an organization exceeding its plan. It does nothing
 * about a loop spending that plan in seconds — a stuck retry or a double-bound
 * button — and the first anyone would hear of it is the bill.
 */
describe('the rate limit', () => {
  it('refuses a burst faster than a person could produce, and charges nothing for it', async () => {
    // Ten a minute is the per-user ceiling; the eleventh in the same instant is
    // not a human pressing a button.
    for (let i = 0; i < 10; i++) {
      await caption(ctxA, BRAND_A).catch(() => null);
    }

    const before = await platformDb.aIUsage.count({ where: { organizationId: ORG_A } });

    await expect(caption(ctxA, BRAND_A)).rejects.toBeInstanceOf(RateLimitedError);

    // Refused before the provider and before metering: no usage row, so no
    // credit was spent on a request that never ran.
    expect(await platformDb.aIUsage.count({ where: { organizationId: ORG_A } })).toBe(before);
  });

  it('tells the caller how long to wait', async () => {
    for (let i = 0; i < 10; i++) await caption(ctxA, BRAND_A).catch(() => null);

    const error = await caption(ctxA, BRAND_A).then(
      () => null,
      (e: unknown) => e as RateLimitedError,
    );

    expect(error?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('is scoped per organization, so one tenant burst cannot starve another', async () => {
    for (let i = 0; i < 10; i++) await caption(ctxA, BRAND_A).catch(() => null);
    await expect(caption(ctxA, BRAND_A)).rejects.toBeInstanceOf(RateLimitedError);

    // B has spent nothing and is unaffected.
    await expect(caption(ctxB, BRAND_B)).resolves.toBeDefined();
  });
});
