import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME, devIdentityProvider } from '@orbit/auth';
import { platformDb } from '@orbit/db';
import { closeQueues, closeSharedConnection } from '@orbit/queue';
import { GET as getWorkspaces } from '../../../app/api/v1/portal/workspaces/route';
import { GET as getCalendar } from '../../../app/api/v1/portal/workspaces/[workspaceId]/calendar/route';
import { GET as getApprovals } from '../../../app/api/v1/portal/workspaces/[workspaceId]/approvals/route';
import { GET as getPublished } from '../../../app/api/v1/portal/workspaces/[workspaceId]/published/route';
import { GET as getPost } from '../../../app/api/v1/portal/posts/[postId]/route';
import { POST as decide } from '../../../app/api/v1/portal/posts/[postId]/decide/route';
import {
  GET as getComments,
  POST as postComment,
} from '../../../app/api/v1/portal/posts/[postId]/comments/route';
import { GET as agencyPosts } from '../../../app/api/v1/orgs/[orgSlug]/posts/route';

/**
 * The client portal at the HTTP boundary (SRS §21, decision D-012, T1.16).
 *
 * These run the **real route handlers** and assert on the **serialised
 * payload**, not on service return values. That distinction is the whole point:
 * §21 requires that internal information is absent from what the client
 * receives, and the only honest way to check "absent" is to search the bytes
 * that would go over the wire.
 *
 * The interesting tests here are all negative.
 */

// ── Tenant A: the agency ────────────────────────────────────────────────────
const ORG_A = '018ffe00-0000-7000-8000-0000fe000001';
const WS_A = '018ffe00-0000-7000-8000-0000fe000002';
const WS_OTHER = '018ffe00-0000-7000-8000-0000fe000003';
const BRAND_A = '018ffe00-0000-7000-8000-0000fe000004';
const ACCOUNT_A = '018ffe00-0000-7000-8000-0000fe000005';

const POST_REVIEW = '018ffe00-0000-7000-8000-0000fe000010';
const POST_DRAFT = '018ffe00-0000-7000-8000-0000fe000011';
const POST_OTHER_WS = '018ffe00-0000-7000-8000-0000fe000012';
const POST_PUBLISHED = '018ffe00-0000-7000-8000-0000fe000013';

const OWNER_A = '018ffe00-0000-7000-8000-0000fe000020';
const CREATOR_A = '018ffe00-0000-7000-8000-0000fe000021';
const CLIENT_A = '018ffe00-0000-7000-8000-0000fe000022';
const CLIENT_OTHER = '018ffe00-0000-7000-8000-0000fe000023';

// ── Tenant B: a different agency entirely ───────────────────────────────────
const ORG_B = '018fff00-0000-7000-8000-0000ff000001';
const WS_B = '018fff00-0000-7000-8000-0000ff000002';
const BRAND_B = '018fff00-0000-7000-8000-0000ff000003';
const POST_B = '018fff00-0000-7000-8000-0000ff000010';
const CLIENT_B = '018fff00-0000-7000-8000-0000ff000020';

const MEDIA_A = '018ffe00-0000-7000-8000-0000fe000030';
const STORAGE_KEY = `org/${ORG_A}/workspace/${WS_A}/1970/01/${MEDIA_A}/original.jpg`;

const INTERNAL_COMMENT_BODY = 'Client is being difficult about the logo again';
const CLIENT_COMMENT_BODY = 'Here is the draft for your review';

/**
 * Strings that must never appear in a portal payload.
 *
 * Field names and actual internal values together: a rename would slip past a
 * name-only check, and a value-only check cannot catch an empty field that
 * still advertises its existence.
 */
const FORBIDDEN_IN_PAYLOAD = [
  // Agency staffing and workflow configuration
  'createdById',
  'assignedToId',
  'approvalRequired',
  'requestedById',
  'decidedById',
  'onBehalfOf',
  // Publishing internals
  'socialAccountId',
  'externalPostId',
  'claimToken',
  'claimedAt',
  'lastError',
  'contentHash',
  'platformOptions',
  // Comment machinery
  'visibility',
  'INTERNAL',
  'mentionedUserIds',
  // Storage internals
  'storageKey',
  // Actual internal content
  INTERNAL_COMMENT_BODY,
  // Identities of agency staff
  CREATOR_A,
  OWNER_A,
] as const;

let sessionClientA: string;
let sessionClientOther: string;
let sessionClientB: string;
let sessionOwnerA: string;

function request(path: string, init: { cookie?: string; body?: unknown } = {}): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.cookie) headers.set('cookie', `${SESSION_COOKIE_NAME}=${init.cookie}`);

  return new NextRequest(`http://localhost:3000${path}`, {
    method: init.body ? 'POST' : 'GET',
    headers,
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
}

const params = <P>(value: P) => ({ params: Promise.resolve(value) });

/** Read the body once, and give back both the parsed object and its raw text. */
async function read(response: Response): Promise<{ status: number; json: unknown; text: string }> {
  const text = await response.text();
  return {
    status: response.status,
    json: text.length > 0 ? (JSON.parse(text) as unknown) : null,
    text,
  };
}

function assertNoLeaks(text: string, label: string) {
  for (const forbidden of FORBIDDEN_IN_PAYLOAD) {
    expect(text, `${label} leaked ${forbidden}`).not.toContain(forbidden);
  }
}

async function seedUser(
  id: string,
  email: string,
  organizationId: string,
  role: string,
  workspace?: { id: string; role: string },
) {
  await platformDb.user.upsert({
    where: { id },
    update: {},
    create: { id, firebaseUid: `dev:${email}`, email },
  });
  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId, userId: id } },
    update: { role: role as 'CLIENT', status: 'ACTIVE' },
    create: { organizationId, userId: id, role: role as 'CLIENT', status: 'ACTIVE' },
  });

  if (workspace) {
    await platformDb.workspaceMembership.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: id } },
      update: {},
      create: {
        organizationId,
        workspaceId: workspace.id,
        userId: id,
        role: workspace.role as 'CLIENT_APPROVER',
      },
    });
  }
}

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG_A, 't16a'],
    [ORG_B, 't16b'],
  ] as const) {
    await platformDb.organization.upsert({
      where: { id },
      update: {},
      create: { id, name: slug, slug, timezone: 'UTC' },
    });
  }

  for (const [id, org, name] of [
    [WS_A, ORG_A, 'acme'],
    [WS_OTHER, ORG_A, 'other-client'],
    [WS_B, ORG_B, 'b-client'],
  ] as const) {
    await platformDb.workspace.upsert({
      where: { id },
      update: {},
      create: { id, organizationId: org, name, slug: name, timezone: 'UTC' },
    });
  }

  for (const [id, org, ws, name] of [
    [BRAND_A, ORG_A, WS_A, 'acme-brand'],
    [BRAND_B, ORG_B, WS_B, 'b-brand'],
  ] as const) {
    await platformDb.brand.upsert({
      where: { id },
      update: {},
      create: { id, organizationId: org, workspaceId: ws, name, slug: name },
    });
  }

  await platformDb.socialAccount.upsert({
    where: { id: ACCOUNT_A },
    update: {},
    create: {
      id: ACCOUNT_A,
      organizationId: ORG_A,
      workspaceId: WS_A,
      brandId: BRAND_A,
      platform: 'FACEBOOK',
      externalId: 'ext-portal',
      displayName: 'Acme Bakery',
      accountType: 'PAGE',
      status: 'ACTIVE',
    },
  });

  await seedUser(OWNER_A, 'owner@t16a.test', ORG_A, 'OWNER');
  await seedUser(CREATOR_A, 'creator@t16a.test', ORG_A, 'CONTENT_CREATOR', {
    id: WS_A,
    role: 'CONTRIBUTOR',
  });
  await seedUser(CLIENT_A, 'client@t16a.test', ORG_A, 'CLIENT', {
    id: WS_A,
    role: 'CLIENT_APPROVER',
  });
  await seedUser(CLIENT_OTHER, 'other@t16a.test', ORG_A, 'CLIENT', {
    id: WS_OTHER,
    role: 'CLIENT_APPROVER',
  });
  await seedUser(CLIENT_B, 'client@t16b.test', ORG_B, 'CLIENT', {
    id: WS_B,
    role: 'CLIENT_APPROVER',
  });

  // After the users, because `uploadedById` is a real foreign key.
  await platformDb.mediaAsset.upsert({
    where: { id: MEDIA_A },
    update: {},
    create: {
      id: MEDIA_A,
      organizationId: ORG_A,
      workspaceId: WS_A,
      brandId: BRAND_A,
      kind: 'IMAGE',
      storageKey: STORAGE_KEY,
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
      width: 800,
      height: 600,
      status: 'READY',
      originalFilename: 'agency-internal-naming-v3-FINAL.jpg',
      uploadedById: CREATOR_A,
    },
  });

  sessionClientA = await devIdentityProvider.createSessionCookie('dev:client@t16a.test', 3_600_000);
  sessionClientOther = await devIdentityProvider.createSessionCookie(
    'dev:other@t16a.test',
    3_600_000,
  );
  sessionClientB = await devIdentityProvider.createSessionCookie('dev:client@t16b.test', 3_600_000);
  sessionOwnerA = await devIdentityProvider.createSessionCookie('dev:owner@t16a.test', 3_600_000);
});

beforeEach(async () => {
  await platformDb.comment.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.approval.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.postMedia.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.postVariant.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.post.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });

  // With the client, awaiting their decision.
  await platformDb.post.create({
    data: {
      id: POST_REVIEW,
      organizationId: ORG_A,
      workspaceId: WS_A,
      brandId: BRAND_A,
      title: 'Spring launch',
      body: 'A perfectly ordinary announcement.',
      status: 'CLIENT_REVIEW',
      createdById: CREATOR_A,
      assignedToId: OWNER_A,
      contentHash: 'deadbeef',
    },
  });

  await platformDb.postVariant.create({
    data: {
      id: '018ffe00-0000-7000-8000-0000fe000040',
      organizationId: ORG_A,
      postId: POST_REVIEW,
      socialAccountId: ACCOUNT_A,
      platform: 'FACEBOOK',
      body: 'The Facebook version.',
      status: 'DRAFT',
      lastError: { code: 'PROVIDER_VALIDATION_ERROR', message: 'internal detail' },
      claimToken: 'secret-claim-token',
    },
  });

  await platformDb.postMedia.create({
    data: {
      organizationId: ORG_A,
      postId: POST_REVIEW,
      mediaAssetId: MEDIA_A,
      position: 0,
      altText: 'A cake',
    },
  });

  // The internal gate, already decided, plus the client's open one.
  await platformDb.approval.create({
    data: {
      organizationId: ORG_A,
      postId: POST_REVIEW,
      stage: 'INTERNAL',
      state: 'APPROVED',
      requestedById: CREATOR_A,
      decidedById: OWNER_A,
      decidedAt: new Date('2026-06-01T00:00:00.000Z'),
      comment: 'Looks fine, send it on',
    },
  });
  await platformDb.approval.create({
    data: {
      organizationId: ORG_A,
      postId: POST_REVIEW,
      stage: 'CLIENT',
      state: 'PENDING',
      requestedById: OWNER_A,
    },
  });

  await platformDb.comment.create({
    data: {
      organizationId: ORG_A,
      postId: POST_REVIEW,
      authorId: OWNER_A,
      body: INTERNAL_COMMENT_BODY,
      visibility: 'INTERNAL',
    },
  });
  await platformDb.comment.create({
    data: {
      organizationId: ORG_A,
      postId: POST_REVIEW,
      authorId: OWNER_A,
      body: CLIENT_COMMENT_BODY,
      visibility: 'CLIENT_VISIBLE',
    },
  });

  // Not yet theirs.
  await platformDb.post.create({
    data: {
      id: POST_DRAFT,
      organizationId: ORG_A,
      workspaceId: WS_A,
      brandId: BRAND_A,
      title: 'Unfinished idea',
      body: 'Nowhere near ready.',
      status: 'DRAFT',
      createdById: CREATOR_A,
    },
  });

  // Another client of the same agency.
  await platformDb.post.create({
    data: {
      id: POST_OTHER_WS,
      organizationId: ORG_A,
      workspaceId: WS_OTHER,
      brandId: BRAND_A,
      title: 'A different client’s campaign',
      body: 'Confidential to them.',
      status: 'CLIENT_REVIEW',
    },
  });

  await platformDb.post.create({
    data: {
      id: POST_PUBLISHED,
      organizationId: ORG_A,
      workspaceId: WS_A,
      brandId: BRAND_A,
      title: 'Last week',
      body: 'Already out.',
      status: 'PUBLISHED',
      publishedAt: new Date('2026-06-01T09:00:00.000Z'),
    },
  });
  await platformDb.postVariant.create({
    data: {
      organizationId: ORG_A,
      postId: POST_PUBLISHED,
      socialAccountId: ACCOUNT_A,
      platform: 'FACEBOOK',
      body: '',
      status: 'PUBLISHED',
      externalPostId: '123_456',
      externalPermalink: 'https://facebook.com/123_456',
      publishedAt: new Date('2026-06-01T09:00:00.000Z'),
    },
  });

  // A different tenant entirely.
  await platformDb.post.create({
    data: {
      id: POST_B,
      organizationId: ORG_B,
      workspaceId: WS_B,
      brandId: BRAND_B,
      title: 'Tenant B campaign',
      body: 'Belongs to another agency.',
      status: 'CLIENT_REVIEW',
    },
  });
});

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await platformDb.user.deleteMany({
    where: { id: { in: [OWNER_A, CREATOR_A, CLIENT_A, CLIENT_OTHER, CLIENT_B] } },
  });
  await platformDb.$disconnect();
  await closeQueues();
  await closeSharedConnection();
});

// ── Payload-level leakage (the §21 requirement) ─────────────────────────────

describe('what a client receives', () => {
  it('shows the post, its variants and its media', async () => {
    const response = await getPost(
      request(`/api/v1/portal/posts/${POST_REVIEW}`, { cookie: sessionClientA }),
      params({ postId: POST_REVIEW }),
    );

    const { status, json, text } = await read(response);
    expect(status).toBe(200);

    const body = json as {
      post: { title: string; variants: Array<{ body: string; socialAccount: unknown }> };
      media: Array<{ url: string; asset: unknown }>;
      comments: Array<{ body: string }>;
      approval: { state: string } | null;
    };

    expect(body.post.title).toBe('Spring launch');
    expect(body.post.variants[0]?.body).toBe('The Facebook version.');
    // The account's display name is all a Client gets (docs/RBAC.md §4.3).
    expect(text).toContain('Acme Bakery');
    expect(body.media[0]?.url).toContain(MEDIA_A);
    expect(body.approval?.state).toBe('PENDING');
  });

  it('leaks nothing internal in the post payload', async () => {
    const response = await getPost(
      request(`/api/v1/portal/posts/${POST_REVIEW}`, { cookie: sessionClientA }),
      params({ postId: POST_REVIEW }),
    );

    const { text } = await read(response);
    assertNoLeaks(text, 'portal post');
  });

  it('shows client-visible comments and not internal ones', async () => {
    const response = await getComments(
      request(`/api/v1/portal/posts/${POST_REVIEW}/comments`, { cookie: sessionClientA }),
      params({ postId: POST_REVIEW }),
    );

    const { status, json, text } = await read(response);
    expect(status).toBe(200);

    const body = json as { comments: Array<{ body: string }> };
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0]?.body).toBe(CLIENT_COMMENT_BODY);
    assertNoLeaks(text, 'portal comments');
  });

  it('never mentions the internal approval round', async () => {
    const response = await getPost(
      request(`/api/v1/portal/posts/${POST_REVIEW}`, { cookie: sessionClientA }),
      params({ postId: POST_REVIEW }),
    );

    const { text } = await read(response);

    // The internal gate's own comment is the giveaway to look for.
    expect(text).not.toContain('Looks fine, send it on');
    expect(text).not.toContain('INTERNAL');
  });

  it('leaks nothing in the calendar, approvals or published views', async () => {
    const cases: Array<[string, Response]> = [
      [
        'calendar',
        await getCalendar(
          request(`/api/v1/portal/workspaces/${WS_A}/calendar`, { cookie: sessionClientA }),
          params({ workspaceId: WS_A }),
        ),
      ],
      [
        'approvals',
        await getApprovals(
          request(`/api/v1/portal/workspaces/${WS_A}/approvals`, { cookie: sessionClientA }),
          params({ workspaceId: WS_A }),
        ),
      ],
      [
        'published',
        await getPublished(
          request(`/api/v1/portal/workspaces/${WS_A}/published`, { cookie: sessionClientA }),
          params({ workspaceId: WS_A }),
        ),
      ],
    ];

    for (const [label, response] of cases) {
      const { status, text } = await read(response);
      expect(status, label).toBe(200);
      assertNoLeaks(text, label);
    }
  });

  it('does not show a post that has not reached them', async () => {
    const { status, text } = await read(
      await getCalendar(
        request(`/api/v1/portal/workspaces/${WS_A}/calendar`, { cookie: sessionClientA }),
        params({ workspaceId: WS_A }),
      ),
    );

    expect(status).toBe(200);
    expect(text).not.toContain('Unfinished idea');
    expect(text).not.toContain('Nowhere near ready');
  });

  it('shows only variants that actually published', async () => {
    const { json, text } = await read(
      await getPublished(
        request(`/api/v1/portal/workspaces/${WS_A}/published`, { cookie: sessionClientA }),
        params({ workspaceId: WS_A }),
      ),
    );

    const body = json as { posts: Array<{ variants: Array<{ externalPermalink: string }> }> };
    expect(body.posts).toHaveLength(1);
    expect(body.posts[0]?.variants[0]?.externalPermalink).toBe('https://facebook.com/123_456');
    // The permalink is public and useful; the platform's own post id is neither,
    // and `externalPostId` is not in the projection at all.
    expect(text).not.toContain('externalPostId');
  });
});

// ── Isolation ───────────────────────────────────────────────────────────────

describe('isolation', () => {
  it('refuses a post in another workspace of the same agency, by exact id', async () => {
    // The client knows the UUID exactly. It is still a 404.
    const { status } = await read(
      await getPost(
        request(`/api/v1/portal/posts/${POST_OTHER_WS}`, { cookie: sessionClientA }),
        params({ postId: POST_OTHER_WS }),
      ),
    );

    expect(status).toBe(404);
  });

  it('refuses a post in another tenant, by exact id', async () => {
    const { status } = await read(
      await getPost(
        request(`/api/v1/portal/posts/${POST_B}`, { cookie: sessionClientA }),
        params({ postId: POST_B }),
      ),
    );

    expect(status).toBe(404);
  });

  it('refuses another workspace’s calendar, by exact id', async () => {
    const { status } = await read(
      await getCalendar(
        request(`/api/v1/portal/workspaces/${WS_OTHER}/calendar`, { cookie: sessionClientA }),
        params({ workspaceId: WS_OTHER }),
      ),
    );

    expect(status).toBe(404);
  });

  it('refuses another tenant’s workspace, by exact id', async () => {
    const { status } = await read(
      await getCalendar(
        request(`/api/v1/portal/workspaces/${WS_B}/calendar`, { cookie: sessionClientA }),
        params({ workspaceId: WS_B }),
      ),
    );

    expect(status).toBe(404);
  });

  it('cannot decide on another workspace’s post, by exact id', async () => {
    const { status } = await read(
      await decide(
        request(`/api/v1/portal/posts/${POST_OTHER_WS}/decide`, {
          cookie: sessionClientA,
          body: { decision: 'APPROVED' },
        }),
        params({ postId: POST_OTHER_WS }),
      ),
    );

    expect(status).toBe(404);

    const untouched = await platformDb.post.findUniqueOrThrow({ where: { id: POST_OTHER_WS } });
    expect(untouched.status).toBe('CLIENT_REVIEW');
  });

  it('lists only the workspaces the client belongs to', async () => {
    const { json } = await read(
      await getWorkspaces(request('/api/v1/portal/workspaces', { cookie: sessionClientA })),
    );

    const body = json as { workspaces: Array<{ id: string; name: string }> };
    expect(body.workspaces.map((w) => w.id)).toEqual([WS_A]);
  });

  it('gives a client of another agency none of this agency’s workspaces', async () => {
    const { json } = await read(
      await getWorkspaces(request('/api/v1/portal/workspaces', { cookie: sessionClientB })),
    );

    const body = json as { workspaces: Array<{ id: string }> };
    expect(body.workspaces.map((w) => w.id)).toEqual([WS_B]);
  });
});

// ── The two surfaces do not overlap ─────────────────────────────────────────

describe('surface separation', () => {
  it('refuses an internal user on a portal route', async () => {
    const { status } = await read(
      await getPost(
        request(`/api/v1/portal/posts/${POST_REVIEW}`, { cookie: sessionOwnerA }),
        params({ postId: POST_REVIEW }),
      ),
    );

    // 404, not 403 — an Owner probing portal URLs learns nothing.
    expect(status).toBe(404);
  });

  it('refuses a client on an agency route', async () => {
    // docs/RBAC.md §1 rule 3. Before T1.16 this returned 200 with an
    // agency-shaped payload.
    const { status } = await read(
      await agencyPosts(
        request(`/api/v1/orgs/t16a/posts`, { cookie: sessionClientA }),
        params({ orgSlug: 't16a' }),
      ),
    );

    expect(status).toBe(404);
  });

  it('still lets an internal user use the agency route', async () => {
    const { status } = await read(
      await agencyPosts(
        request(`/api/v1/orgs/t16a/posts`, { cookie: sessionOwnerA }),
        params({ orgSlug: 't16a' }),
      ),
    );

    expect(status).toBe(200);
  });
});

// ── Deciding ────────────────────────────────────────────────────────────────

describe('deciding', () => {
  it('approves, and moves the post through the real state machine', async () => {
    const { status, json, text } = await read(
      await decide(
        request(`/api/v1/portal/posts/${POST_REVIEW}/decide`, {
          cookie: sessionClientA,
          body: { decision: 'APPROVED' },
        }),
        params({ postId: POST_REVIEW }),
      ),
    );

    expect(status).toBe(200);
    assertNoLeaks(text, 'decision response');

    const body = json as { post: { status: string }; decision: string };
    expect(body.post.status).toBe('APPROVED');
    expect(body.decision).toBe('APPROVED');

    const post = await platformDb.post.findUniqueOrThrow({ where: { id: POST_REVIEW } });
    expect(post.status).toBe('APPROVED');

    const approval = await platformDb.approval.findFirstOrThrow({
      where: { postId: POST_REVIEW, stage: 'CLIENT' },
    });
    expect(approval.state).toBe('APPROVED');
    expect(approval.decidedById).toBe(CLIENT_A);
    expect(approval.onBehalfOf).toBe(false);
  });

  it('requests changes, and requires a note', async () => {
    const without = await read(
      await decide(
        request(`/api/v1/portal/posts/${POST_REVIEW}/decide`, {
          cookie: sessionClientA,
          body: { decision: 'CHANGES_REQUESTED' },
        }),
        params({ postId: POST_REVIEW }),
      ),
    );
    expect(without.status).toBe(400);

    const withNote = await read(
      await decide(
        request(`/api/v1/portal/posts/${POST_REVIEW}/decide`, {
          cookie: sessionClientA,
          body: { decision: 'CHANGES_REQUESTED', comment: 'Please use the new logo.' },
        }),
        params({ postId: POST_REVIEW }),
      ),
    );
    expect(withNote.status).toBe(200);

    const post = await platformDb.post.findUniqueOrThrow({ where: { id: POST_REVIEW } });
    expect(post.status).toBe('CHANGES_REQUESTED');
  });

  it('refuses a second decision on a gate already answered', async () => {
    await decide(
      request(`/api/v1/portal/posts/${POST_REVIEW}/decide`, {
        cookie: sessionClientA,
        body: { decision: 'APPROVED' },
      }),
      params({ postId: POST_REVIEW }),
    );

    const { status } = await read(
      await decide(
        request(`/api/v1/portal/posts/${POST_REVIEW}/decide`, {
          cookie: sessionClientA,
          body: { decision: 'APPROVED' },
        }),
        params({ postId: POST_REVIEW }),
      ),
    );

    // 403, and from the RBAC layer rather than the service: a Client's
    // `post:approve_client` grant is restricted to `CLIENT_REVIEW`, and the post
    // is now `APPROVED`. The grant matrix refuses it before any of the approval
    // machinery is reached — which is the right order, even though a 409 would
    // read more kindly.
    expect(status).toBe(403);

    const post = await platformDb.post.findUniqueOrThrow({ where: { id: POST_REVIEW } });
    expect(post.status).toBe('APPROVED');
  });

  it('refuses a decision on a post that never reached the client', async () => {
    const { status } = await read(
      await decide(
        request(`/api/v1/portal/posts/${POST_DRAFT}/decide`, {
          cookie: sessionClientA,
          body: { decision: 'APPROVED' },
        }),
        params({ postId: POST_DRAFT }),
      ),
    );

    expect(status).toBe(404);
  });

  it('refuses a body trying to record the decision on someone’s behalf', async () => {
    const { status } = await read(
      await decide(
        request(`/api/v1/portal/posts/${POST_REVIEW}/decide`, {
          cookie: sessionClientA,
          body: { decision: 'APPROVED', onBehalfOf: true, reason: 'they told me on the phone' },
        }),
        params({ postId: POST_REVIEW }),
      ),
    );

    // A logged 400, not a silent strip.
    expect(status).toBe(400);

    const post = await platformDb.post.findUniqueOrThrow({ where: { id: POST_REVIEW } });
    expect(post.status).toBe('CLIENT_REVIEW');
  });
});

// ── Commenting ──────────────────────────────────────────────────────────────

describe('commenting', () => {
  it('writes a client-visible comment', async () => {
    const { status, text } = await read(
      await postComment(
        request(`/api/v1/portal/posts/${POST_REVIEW}/comments`, {
          cookie: sessionClientA,
          body: { body: 'Could the cake be bigger?' },
        }),
        params({ postId: POST_REVIEW }),
      ),
    );

    expect(status).toBe(201);
    assertNoLeaks(text, 'created comment');

    const stored = await platformDb.comment.findFirstOrThrow({
      where: { postId: POST_REVIEW, authorId: CLIENT_A },
    });
    expect(stored.visibility).toBe('CLIENT_VISIBLE');
  });

  it('refuses a body that tries to set visibility', async () => {
    const { status } = await read(
      await postComment(
        request(`/api/v1/portal/posts/${POST_REVIEW}/comments`, {
          cookie: sessionClientA,
          body: { body: 'sneaky', visibility: 'INTERNAL' },
        }),
        params({ postId: POST_REVIEW }),
      ),
    );

    expect(status).toBe(400);
    expect(
      await platformDb.comment.count({ where: { postId: POST_REVIEW, authorId: CLIENT_A } }),
    ).toBe(0);
  });

  it('cannot reply into an internal thread', async () => {
    const internal = await platformDb.comment.findFirstOrThrow({
      where: { postId: POST_REVIEW, visibility: 'INTERNAL' },
    });

    const { status } = await read(
      await postComment(
        request(`/api/v1/portal/posts/${POST_REVIEW}/comments`, {
          cookie: sessionClientA,
          body: { body: 'replying where I should not be', parentId: internal.id },
        }),
        params({ postId: POST_REVIEW }),
      ),
    );

    // 404: the parent is not a comment this client can see.
    expect(status).toBe(404);
  });

  it('cannot comment on another workspace’s post', async () => {
    const { status } = await read(
      await postComment(
        request(`/api/v1/portal/posts/${POST_OTHER_WS}/comments`, {
          cookie: sessionClientOther === '' ? sessionClientA : sessionClientA,
          body: { body: 'not mine' },
        }),
        params({ postId: POST_OTHER_WS }),
      ),
    );

    expect(status).toBe(404);
  });
});
