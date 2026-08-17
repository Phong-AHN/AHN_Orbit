import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, type TenantContext } from '@orbit/core';
import { devIdentityProvider, resolveTenantContext, resolveUser } from '@orbit/auth';
import { platformDb } from '@orbit/db';
import { convertIdeaToPost, createIdea, listIdeas, planningWindow, updateIdea } from './service';

/**
 * Content ideas against the real database (Phase 4 P2).
 *
 * The two properties worth proving are the ones that would cost somebody real
 * work: that an idea converts **exactly once** — a double-clicked button must
 * not produce two drafts, one of which eventually publishes — and that
 * conversion produces a `DRAFT` and nothing further along, because SRS §25 is
 * explicit that AI-originated content never reaches publishing on its own.
 */

const ORG_A = '018f1000-0000-7000-8000-001000000001';
const ORG_B = '018f1100-0000-7000-8000-001100000001';
const WS_A = '018f1000-0000-7000-8000-001000000002';
const WS_B = '018f1100-0000-7000-8000-001100000002';
const BRAND_A = '018f1000-0000-7000-8000-001000000003';
const BRAND_B = '018f1100-0000-7000-8000-001100000003';

const fingerprint = { ip: '127.0.0.1', userAgent: 'vitest' };

let ctxA: TenantContext;
let ctxB: TenantContext;

async function seed(org: string, ws: string, brand: string, slug: string, email: string) {
  await platformDb.organization.upsert({
    where: { id: org },
    update: {},
    create: { id: org, name: slug, slug, timezone: 'UTC' },
  });
  await platformDb.workspace.upsert({
    where: { id: ws },
    update: {},
    create: { id: ws, organizationId: org, name: slug, slug, timezone: 'UTC' },
  });
  await platformDb.brand.upsert({
    where: { id: brand },
    update: {},
    create: { id: brand, organizationId: org, workspaceId: ws, name: slug, slug },
  });

  const identity = await devIdentityProvider.verifyIdToken(`dev:${email}`);
  const user = await resolveUser(identity);

  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: org, userId: user.id } },
    update: {},
    create: { organizationId: org, userId: user.id, role: 'OWNER', status: 'ACTIVE' },
  });

  const { ctx } = await resolveTenantContext(user, org, 'itest-ideas');
  return ctx;
}

beforeAll(async () => {
  ctxA = await seed(ORG_A, WS_A, BRAND_A, 'idea-a', 'owner@idea-a.test');
  ctxB = await seed(ORG_B, WS_B, BRAND_B, 'idea-b', 'owner@idea-b.test');
});

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await platformDb.user.deleteMany({ where: { email: { endsWith: '.test' } } });
});

beforeEach(async () => {
  await platformDb.post.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.contentIdea.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
});

const idea = (overrides: Record<string, unknown> = {}) => ({
  workspaceId: WS_A,
  brandId: BRAND_A,
  topic: 'Behind the scenes at the roastery',
  ...overrides,
});

describe('creating and listing', () => {
  it('starts an idea as SUGGESTED and attributes it to the session', async () => {
    const created = await createIdea(ctxA, idea(), fingerprint);

    expect(created.state).toBe('SUGGESTED');
    expect(created.generatedBy?.email).toBe('owner@idea-a.test');
  });

  it('refuses a brand from another tenant, by exact id', async () => {
    await expect(
      createIdea(ctxA, idea({ brandId: BRAND_B, workspaceId: WS_B }), fingerprint),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('never lists another tenant ideas', async () => {
    await createIdea(ctxB, { workspaceId: WS_B, brandId: BRAND_B, topic: 'Theirs' }, fingerprint);

    expect(await listIdeas(ctxA)).toHaveLength(0);
    expect(await listIdeas(ctxB)).toHaveLength(1);
  });

  it('searches on topic and hook', async () => {
    await createIdea(ctxA, idea({ topic: 'Roastery tour' }), fingerprint);
    await createIdea(ctxA, idea({ topic: 'Something else', hook: 'A roastery hook' }), fingerprint);
    await createIdea(ctxA, idea({ topic: 'Unrelated' }), fingerprint);

    expect(await listIdeas(ctxA, { search: 'roastery' })).toHaveLength(2);
  });

  it('writes an audit row', async () => {
    await createIdea(ctxA, idea(), fingerprint);

    expect(
      await platformDb.auditLog.findFirst({
        where: { organizationId: ORG_A, action: 'content_idea.created' },
      }),
    ).not.toBeNull();
  });
});

describe('converting to a post', () => {
  it('creates a DRAFT and nothing further along', async () => {
    const created = await createIdea(ctxA, idea({ hook: 'The 5am start' }), fingerprint);

    const post = await convertIdeaToPost(ctxA, created.id, fingerprint);

    // SRS §25: AI-originated content never reaches publishing on its own.
    expect(post.status).toBe('DRAFT');
    expect(post.title).toBe('Behind the scenes at the roastery');
    expect(post.body).toContain('The 5am start');
  });

  it('records where the post came from', async () => {
    const created = await createIdea(ctxA, idea(), fingerprint);
    const post = await convertIdeaToPost(ctxA, created.id, fingerprint);

    const row = await platformDb.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row.sourceIdeaId).toBe(created.id);
    expect(row.source).toBe('AI_IDEA');
  });

  it('marks the idea converted', async () => {
    const created = await createIdea(ctxA, idea(), fingerprint);
    await convertIdeaToPost(ctxA, created.id, fingerprint);

    const after = await platformDb.contentIdea.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.state).toBe('CONVERTED');
  });

  /**
   * The one that matters. A double-clicked button producing two drafts is how
   * an agency ends up publishing the same thing twice — and the second draft is
   * the one nobody notices.
   */
  it('converts exactly once, and the second attempt creates no second post', async () => {
    const created = await createIdea(ctxA, idea(), fingerprint);
    await convertIdeaToPost(ctxA, created.id, fingerprint);

    await expect(convertIdeaToPost(ctxA, created.id, fingerprint)).rejects.toBeInstanceOf(
      ConflictError,
    );

    expect(await platformDb.post.count({ where: { organizationId: ORG_A } })).toBe(1);
  });

  it('does not convert another tenant idea, by exact id', async () => {
    const theirs = await createIdea(
      ctxB,
      { workspaceId: WS_B, brandId: BRAND_B, topic: 'Theirs' },
      fingerprint,
    );

    await expect(convertIdeaToPost(ctxA, theirs.id, fingerprint)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await platformDb.post.count({ where: { organizationId: ORG_B } })).toBe(0);
  });

  it('refuses to edit an idea that already became a post', async () => {
    const created = await createIdea(ctxA, idea(), fingerprint);
    await convertIdeaToPost(ctxA, created.id, fingerprint);

    await expect(
      updateIdea(ctxA, created.id, { topic: 'Rewritten after the fact' }, fingerprint),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('planning', () => {
  it('puts planned ideas and scheduled posts on one timeline', async () => {
    await createIdea(ctxA, idea({ topic: 'Planned', plannedFor: '2026-07-15' }), fingerprint);
    await createIdea(ctxA, idea({ topic: 'Undated' }), fingerprint);

    const window = await planningWindow(ctxA, {
      brandId: BRAND_A,
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2026-07-31T23:59:59.999Z'),
    });

    // Only the dated one falls in the window; the note stays a note.
    expect(window.ideas).toHaveLength(1);
    expect(window.ideas[0]?.topic).toBe('Planned');
  });

  it('leaves a dismissed idea out of the plan', async () => {
    const created = await createIdea(
      ctxA,
      idea({ topic: 'Dropped', plannedFor: '2026-07-15' }),
      fingerprint,
    );
    await updateIdea(ctxA, created.id, { state: 'DISMISSED' }, fingerprint);

    const window = await planningWindow(ctxA, {
      brandId: BRAND_A,
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2026-07-31T23:59:59.999Z'),
    });

    expect(window.ideas).toHaveLength(0);
  });
});
