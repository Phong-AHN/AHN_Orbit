import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConflictError,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
  type TenantContext,
} from '@orbit/core';
import { devIdentityProvider, resolveTenantContext, resolveUser } from '@orbit/auth';
import { platformDb } from '@orbit/db';
import { closeQueues, closeSharedConnection } from '@orbit/queue';
import { s3 } from '@orbit/storage';
import { CreateBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { ensureProvidersRegistered } from '@/server/providers';
import { completeMediaUpload, presignMediaUpload } from '../media/service';
import { createPost, getPost, transitionPost, updatePost } from '../posts/service';
import {
  createComment,
  deleteComment,
  listComments,
  resolveComment,
  updateComment,
} from '../comments/service';
import { approvalScope, decideApproval, listApprovalQueue, listApprovalsForPost } from './service';

/**
 * The approval gate against the real database (T1.10).
 *
 * What these prove that a unit test cannot: that a gate is opened in the same
 * transaction as the status change, that a decision cannot be recorded without
 * the state machine and the grant matrix both agreeing, that reopening voids
 * the round, and — the one with real consequences — that internal chatter and
 * pending internal reviews are invisible to a Client.
 */

const ORG_A = '018fa000-0000-7000-8000-0000a01f0001';
const ORG_B = '018fb000-0000-7000-8000-0000b01f0001';
const WS_A = '018fa000-0000-7000-8000-0000a01f0002';
const WS_B = '018fb000-0000-7000-8000-0000b01f0002';
const BRAND_A = '018fa000-0000-7000-8000-0000a01f0003';
const BRAND_B = '018fb000-0000-7000-8000-0000b01f0003';
const OWNER_A = '018fa000-0000-7000-8000-0000a01f0004';
const OWNER_B = '018fb000-0000-7000-8000-0000b01f0004';
const CREATOR_A = '018fa000-0000-7000-8000-0000a01f0005';
const CLIENT_A = '018fa000-0000-7000-8000-0000a01f0006';
const APPROVER_A = '018fa000-0000-7000-8000-0000a01f0007';
const ACCOUNT_A = '018fa000-0000-7000-8000-0000a01f0008';
const ACCOUNT_B = '018fb000-0000-7000-8000-0000b01f0008';

const fingerprint = { ip: '127.0.0.1', userAgent: 'vitest' };

let ownerA: TenantContext;
let ownerB: TenantContext;
let creatorA: TenantContext;
let clientA: TenantContext;
let approverA: TenantContext;

// ── Fixtures ────────────────────────────────────────────────────────────────

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.alloc(500)]);
}

async function uploadReadyImage(ctx: TenantContext, workspaceId: string): Promise<string> {
  const body = png(1200, 630);
  const presigned = await presignMediaUpload(ctx, {
    workspaceId,
    declaredMimeType: 'image/png',
    declaredSizeBytes: body.length,
  });

  await s3().send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET ?? 'orbit-media-dev',
      Key: presigned.storageKey,
      Body: body,
      ContentType: 'image/png',
    }),
  );

  const asset = await completeMediaUpload(ctx, presigned.assetId, fingerprint);
  return asset.id;
}

async function seedOrg(org: string, ws: string, brand: string, slug: string) {
  await platformDb.organization.upsert({
    where: { id: org },
    update: {},
    create: { id: org, name: slug, slug, timezone: 'UTC' },
  });
  await platformDb.workspace.upsert({
    where: { id: ws },
    update: {},
    create: { id: ws, organizationId: org, name: 'ws', slug: 'main', timezone: 'UTC' },
  });
  await platformDb.brand.upsert({
    where: { id: brand },
    update: {},
    create: { id: brand, organizationId: org, workspaceId: ws, name: 'b', slug: 'b' },
  });
}

async function seedMember(
  org: string,
  ws: string,
  userId: string,
  email: string,
  role: 'OWNER' | 'CONTENT_CREATOR' | 'CLIENT' | 'APPROVER',
  workspaceRole: 'MANAGER' | 'CONTRIBUTOR' | 'CLIENT_APPROVER' | 'APPROVER',
  brand?: string,
) {
  await platformDb.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId, firebaseUid: `dev:${email}`, email, name: email.split('@')[0] ?? null },
  });
  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: org, userId } },
    update: { role, status: 'ACTIVE' },
    create: { organizationId: org, userId, role, status: 'ACTIVE' },
  });
  await platformDb.workspaceMembership.upsert({
    where: { workspaceId_userId: { workspaceId: ws, userId } },
    update: { role: workspaceRole },
    create: { organizationId: org, workspaceId: ws, userId, role: workspaceRole },
  });
  if (brand) {
    await platformDb.brandAssignment.upsert({
      where: { brandId_userId: { brandId: brand, userId } },
      update: { canApprove: true },
      create: { organizationId: org, brandId: brand, userId, canApprove: true },
    });
  }
}

async function seedAccount(id: string, org: string, ws: string, brand: string, name: string) {
  await platformDb.socialAccount.upsert({
    where: { id },
    update: { status: 'ACTIVE' },
    create: {
      id,
      organizationId: org,
      workspaceId: ws,
      brandId: brand,
      platform: 'FACEBOOK',
      externalId: `ext-${id.slice(-8)}`,
      displayName: name,
      handle: name.toLowerCase(),
      accountType: 'PAGE',
      status: 'ACTIVE',
    },
  });
}

async function contextFor(email: string, orgId: string): Promise<TenantContext> {
  const user = await resolveUser(await devIdentityProvider.verifyIdToken(`dev:${email}`));
  return (await resolveTenantContext(user, orgId)).ctx;
}

/**
 * A post that passes validation, in org A on brand A.
 *
 * `clientGate` maps to `Post.approvalRequired` — whether the client must also
 * sign off before the post is APPROVED.
 */
async function publishablePost(
  options: { clientGate?: boolean; ctx?: TenantContext } = {},
): Promise<string> {
  const ctx = options.ctx ?? ownerA;
  const mediaAssetId = await uploadReadyImage(ctx, WS_A);

  const post = await createPost(
    ctx,
    {
      workspaceId: WS_A,
      brandId: BRAND_A,
      title: 'For review',
      body: 'A perfectly ordinary announcement.',
      hashtags: [],
      mentions: [],
      media: [{ mediaAssetId }],
      socialAccountIds: [ACCOUNT_A],
    },
    fingerprint,
  );

  await updatePost(ownerA, post.id, { approvalRequired: options.clientGate ?? false }, fingerprint);

  return post.id;
}

async function pendingGate(ctx: TenantContext, postId: string) {
  const approvals = await listApprovalsForPost(ctx, postId);
  const pending = approvals.find((a) => a.state === 'PENDING');
  if (!pending) throw new Error('expected a pending gate');
  return pending;
}

beforeAll(async () => {
  ensureProvidersRegistered();

  try {
    await s3().send(
      new CreateBucketCommand({ Bucket: process.env.S3_BUCKET ?? 'orbit-media-dev' }),
    );
  } catch {
    // Already there.
  }

  await seedOrg(ORG_A, WS_A, BRAND_A, 't10a');
  await seedOrg(ORG_B, WS_B, BRAND_B, 't10b');

  await seedMember(ORG_A, WS_A, OWNER_A, 'owner@t10.test', 'OWNER', 'MANAGER');
  await seedMember(ORG_A, WS_A, CREATOR_A, 'creator@t10.test', 'CONTENT_CREATOR', 'CONTRIBUTOR');
  await seedMember(ORG_A, WS_A, CLIENT_A, 'client@t10.test', 'CLIENT', 'CLIENT_APPROVER');
  await seedMember(ORG_A, WS_A, APPROVER_A, 'approver@t10.test', 'APPROVER', 'APPROVER', BRAND_A);
  await seedMember(ORG_B, WS_B, OWNER_B, 'ownerb@t10.test', 'OWNER', 'MANAGER');

  await seedAccount(ACCOUNT_A, ORG_A, WS_A, BRAND_A, 'PageA');
  await seedAccount(ACCOUNT_B, ORG_B, WS_B, BRAND_B, 'PageB');

  ownerA = await contextFor('owner@t10.test', ORG_A);
  creatorA = await contextFor('creator@t10.test', ORG_A);
  clientA = await contextFor('client@t10.test', ORG_A);
  approverA = await contextFor('approver@t10.test', ORG_A);
  ownerB = await contextFor('ownerb@t10.test', ORG_B);
});

beforeEach(async () => {
  await platformDb.comment.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.approval.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.postMedia.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.postVariant.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.post.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.mediaAsset.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
});

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await platformDb.user.deleteMany({
    where: { id: { in: [OWNER_A, OWNER_B, CREATOR_A, CLIENT_A, APPROVER_A] } },
  });
  await platformDb.$disconnect();
  // Transitions enqueue notification jobs since T1.15, so this file now holds a
  // Redis connection it has to give back.
  await closeQueues();
  await closeSharedConnection();
});

// ── Opening a gate ──────────────────────────────────────────────────────────

describe('opening a gate', () => {
  it('opens an internal gate when a post is submitted for review', async () => {
    const postId = await publishablePost();
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);

    const approvals = await listApprovalsForPost(ownerA, postId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      stage: 'INTERNAL',
      state: 'PENDING',
      round: 1,
      requestedById: OWNER_A,
    });
  });

  it('does not open a gate for a status that is not a review', async () => {
    const postId = await publishablePost();
    await transitionPost(ownerA, postId, 'CANCELED', fingerprint);

    expect(await listApprovalsForPost(ownerA, postId)).toHaveLength(0);
  });

  it('records the requester from the session, not the request', async () => {
    const postId = await publishablePost({ ctx: creatorA });
    await transitionPost(creatorA, postId, 'INTERNAL_REVIEW', fingerprint);

    const gate = await pendingGate(ownerA, postId);
    expect(gate.requestedById).toBe(CREATOR_A);
  });

  it('closes the gate when the post is cancelled out of review', async () => {
    const postId = await publishablePost();
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);
    await transitionPost(ownerA, postId, 'CANCELED', fingerprint);

    const approvals = await listApprovalsForPost(ownerA, postId);
    expect(approvals.every((a) => a.state !== 'PENDING')).toBe(true);
  });
});

// ── Deciding ────────────────────────────────────────────────────────────────

describe('deciding a review', () => {
  it('approves internally and finishes review when no client gate applies', async () => {
    const postId = await publishablePost({ clientGate: false });
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);

    const gate = await pendingGate(ownerA, postId);
    const result = await decideApproval(ownerA, gate.id, { decision: 'APPROVED' }, fingerprint);

    expect(result.post.status).toBe('APPROVED');

    const approvals = await listApprovalsForPost(ownerA, postId);
    expect(approvals[0]).toMatchObject({ state: 'APPROVED', decidedById: OWNER_A });
    expect(approvals[0]?.decidedAt).not.toBeNull();
  });

  it('sends an internally approved post to the client when the client gate applies', async () => {
    const postId = await publishablePost({ clientGate: true });
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);

    const internal = await pendingGate(ownerA, postId);
    const result = await decideApproval(ownerA, internal.id, { decision: 'APPROVED' }, fingerprint);

    expect(result.post.status).toBe('CLIENT_REVIEW');

    // And a client gate is now open, in the same round.
    const client = await pendingGate(ownerA, postId);
    expect(client.stage).toBe('CLIENT');
    expect(client.round).toBe(internal.round);
  });

  it('lets the client approve, finishing review', async () => {
    const postId = await publishablePost({ clientGate: true });
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);
    await decideApproval(
      ownerA,
      (await pendingGate(ownerA, postId)).id,
      { decision: 'APPROVED' },
      fingerprint,
    );

    const clientGate = await pendingGate(clientA, postId);
    const result = await decideApproval(
      clientA,
      clientGate.id,
      { decision: 'APPROVED' },
      fingerprint,
    );

    expect(result.post.status).toBe('APPROVED');
    expect((await getPost(ownerA, postId)).status).toBe('APPROVED');
  });

  it('sends a request for changes back to the author', async () => {
    const postId = await publishablePost();
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);

    const gate = await pendingGate(ownerA, postId);
    const result = await decideApproval(
      ownerA,
      gate.id,
      { decision: 'CHANGES_REQUESTED', comment: 'Tighten the opening line.' },
      fingerprint,
    );

    expect(result.post.status).toBe('CHANGES_REQUESTED');

    const approvals = await listApprovalsForPost(ownerA, postId);
    expect(approvals[0]).toMatchObject({
      state: 'CHANGES_REQUESTED',
      comment: 'Tighten the opening line.',
    });
  });

  it('refuses a second decision on an already-answered gate', async () => {
    const postId = await publishablePost();
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);

    const gate = await pendingGate(ownerA, postId);
    await decideApproval(ownerA, gate.id, { decision: 'APPROVED' }, fingerprint);

    await expect(
      decideApproval(
        ownerA,
        gate.id,
        { decision: 'CHANGES_REQUESTED', comment: 'no' },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  it('refuses a stale gate from an earlier round', async () => {
    const postId = await publishablePost();
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);

    const first = await pendingGate(ownerA, postId);
    await decideApproval(ownerA, first.id, { decision: 'APPROVED' }, fingerprint);

    // Reopen, which voids nothing (already decided) but moves the post on.
    await transitionPost(ownerA, postId, 'DRAFT', fingerprint);
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);

    // The round-1 record can no longer answer the round-2 gate.
    await expect(
      decideApproval(ownerA, first.id, { decision: 'APPROVED' }, fingerprint),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  it('does not move the post when the decision is refused', async () => {
    const postId = await publishablePost({ clientGate: true });
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);
    await decideApproval(
      ownerA,
      (await pendingGate(ownerA, postId)).id,
      { decision: 'APPROVED' },
      fingerprint,
    );

    const clientGate = await pendingGate(ownerA, postId);

    // A Content Creator holds no client-approval right.
    await expect(
      decideApproval(creatorA, clientGate.id, { decision: 'APPROVED' }, fingerprint),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // Neither the post nor the gate moved.
    expect((await getPost(ownerA, postId)).status).toBe('CLIENT_REVIEW');
    expect((await pendingGate(ownerA, postId)).state).toBe('PENDING');
  });
});

// ── The client gate cannot be skipped ───────────────────────────────────────

describe('the client gate', () => {
  it('refuses an internal approval straight to APPROVED when the client must sign off', async () => {
    const postId = await publishablePost({ clientGate: true });
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);

    // Even an Owner cannot short-circuit the client's sign-off.
    await expect(transitionPost(ownerA, postId, 'APPROVED', fingerprint)).rejects.toBeInstanceOf(
      ConflictError,
    );

    expect((await getPost(ownerA, postId)).status).toBe('INTERNAL_REVIEW');
  });

  it('allows it when the post does not need client approval', async () => {
    const postId = await publishablePost({ clientGate: false });
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);

    const result = await transitionPost(ownerA, postId, 'APPROVED', fingerprint);
    expect(result.status).toBe('APPROVED');
  });
});

// ── Rounds and reopening ────────────────────────────────────────────────────

describe('rounds', () => {
  it('voids the open gate when approved content is reopened', async () => {
    const postId = await publishablePost({ clientGate: true });
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);
    await decideApproval(
      ownerA,
      (await pendingGate(ownerA, postId)).id,
      { decision: 'APPROVED' },
      fingerprint,
    );

    // A client gate is open; reopening must void it.
    await transitionPost(ownerA, postId, 'CHANGES_REQUESTED', fingerprint);
    await transitionPost(ownerA, postId, 'DRAFT', fingerprint);

    const approvals = await listApprovalsForPost(ownerA, postId);
    expect(approvals.some((a) => a.state === 'PENDING')).toBe(false);
    expect(approvals.some((a) => a.stage === 'CLIENT' && a.state === 'CANCELED')).toBe(true);
  });

  it('starts a new round on resubmission and keeps the old one', async () => {
    const postId = await publishablePost();
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);
    await decideApproval(
      ownerA,
      (await pendingGate(ownerA, postId)).id,
      { decision: 'CHANGES_REQUESTED', comment: 'Not yet.' },
      fingerprint,
    );

    await transitionPost(ownerA, postId, 'DRAFT', fingerprint);
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);

    const approvals = await listApprovalsForPost(ownerA, postId);
    expect(approvals).toHaveLength(2);
    expect(approvals.map((a) => a.round)).toEqual([1, 2]);
    // The first round's decision and comment survive.
    expect(approvals[0]).toMatchObject({ state: 'CHANGES_REQUESTED', comment: 'Not yet.' });
    expect(approvals[1]).toMatchObject({ state: 'PENDING' });
  });

  it('voids approvals when an approved post is reopened for editing', async () => {
    const postId = await publishablePost({ clientGate: true });
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);
    await decideApproval(
      ownerA,
      (await pendingGate(ownerA, postId)).id,
      { decision: 'APPROVED' },
      fingerprint,
    );
    await decideApproval(
      clientA,
      (await pendingGate(clientA, postId)).id,
      { decision: 'APPROVED' },
      fingerprint,
    );

    expect((await getPost(ownerA, postId)).status).toBe('APPROVED');

    // The reopen that D-016 restored, and the round it invalidates.
    await transitionPost(ownerA, postId, 'DRAFT', fingerprint);
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);

    const gate = await pendingGate(ownerA, postId);
    expect(gate.round).toBe(2);
  });
});

// ── Authorization ───────────────────────────────────────────────────────────

describe('who may decide', () => {
  it('refuses a Client the internal gate', async () => {
    const postId = await publishablePost({ clientGate: true });
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);

    const gate = await pendingGate(ownerA, postId);

    // The Client cannot even see the post at INTERNAL_REVIEW, let alone decide.
    await expect(
      decideApproval(clientA, gate.id, { decision: 'APPROVED' }, fingerprint),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses a Content Creator any decision', async () => {
    const postId = await publishablePost({ ctx: creatorA });
    await transitionPost(creatorA, postId, 'INTERNAL_REVIEW', fingerprint);

    const gate = await pendingGate(ownerA, postId);
    await expect(
      decideApproval(creatorA, gate.id, { decision: 'APPROVED' }, fingerprint),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lets a brand Approver decide the internal gate', async () => {
    const postId = await publishablePost({ clientGate: true });
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);

    const gate = await pendingGate(ownerA, postId);
    const result = await decideApproval(approverA, gate.id, { decision: 'APPROVED' }, fingerprint);

    expect(result.post.status).toBe('CLIENT_REVIEW');
  });
});

// ── On behalf of a client ───────────────────────────────────────────────────

describe('recording a client decision on their behalf', () => {
  async function atClientGate() {
    const postId = await publishablePost({ clientGate: true });
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);
    await decideApproval(
      ownerA,
      (await pendingGate(ownerA, postId)).id,
      { decision: 'APPROVED' },
      fingerprint,
    );
    return { postId, gate: await pendingGate(ownerA, postId) };
  }

  it('requires a reason', async () => {
    const { gate } = await atClientGate();

    await expect(
      decideApproval(ownerA, gate.id, { decision: 'APPROVED', onBehalfOf: true }, fingerprint),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('records the flag and the reason in the audit trail', async () => {
    const { postId, gate } = await atClientGate();

    await decideApproval(
      ownerA,
      gate.id,
      { decision: 'APPROVED', onBehalfOf: true, reason: 'Approved by phone with Mai, 12 Aug' },
      fingerprint,
    );

    const approvals = await listApprovalsForPost(ownerA, postId);
    const decided = approvals.find((a) => a.stage === 'CLIENT');
    expect(decided).toMatchObject({ state: 'APPROVED', onBehalfOf: true, decidedById: OWNER_A });

    const entry = await platformDb.auditLog.findFirst({
      where: {
        organizationId: ORG_A,
        resourceId: gate.id,
        action: 'approval.approved_on_behalf_of',
      },
    });
    expect(entry).not.toBeNull();
    expect(entry?.reason).toBe('Approved by phone with Mai, 12 Aug');
    expect(entry?.actorUserId).toBe(OWNER_A);
  });

  it('refuses it on an internal gate', async () => {
    const postId = await publishablePost({ clientGate: true });
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);
    const gate = await pendingGate(ownerA, postId);

    await expect(
      decideApproval(
        ownerA,
        gate.id,
        { decision: 'APPROVED', onBehalfOf: true, reason: 'they said so' },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a Client recording it for anyone', async () => {
    const { gate } = await atClientGate();

    await expect(
      decideApproval(
        clientA,
        gate.id,
        { decision: 'APPROVED', onBehalfOf: true, reason: 'on behalf of my colleague' },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ── Cross-tenant ────────────────────────────────────────────────────────────

describe('cross-tenant access', () => {
  it('hides an approval from another tenant even with the exact id', async () => {
    const postId = await publishablePost();
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);
    const gate = await pendingGate(ownerA, postId);

    await expect(approvalScope(ownerB, gate.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      decideApproval(ownerB, gate.id, { decision: 'APPROVED' }, fingerprint),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(listApprovalsForPost(ownerB, postId)).rejects.toBeInstanceOf(NotFoundError);

    // Untouched.
    expect((await pendingGate(ownerA, postId)).state).toBe('PENDING');
  });

  it('never lists another tenant approvals in the queue', async () => {
    const postId = await publishablePost();
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);

    expect(await listApprovalQueue(ownerB)).toHaveLength(0);
    expect((await listApprovalQueue(ownerA)).length).toBeGreaterThan(0);
  });
});

// ── The queue ───────────────────────────────────────────────────────────────

describe('the approval queue', () => {
  it('lists pending gates and drops them once decided', async () => {
    const postId = await publishablePost();
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);

    expect((await listApprovalQueue(ownerA)).map((a) => a.postId)).toContain(postId);

    await decideApproval(
      ownerA,
      (await pendingGate(ownerA, postId)).id,
      { decision: 'APPROVED' },
      fingerprint,
    );

    expect((await listApprovalQueue(ownerA)).map((a) => a.postId)).not.toContain(postId);
  });

  it('hides a pending internal review from a Client', async () => {
    const postId = await publishablePost({ clientGate: true });
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);

    // The row exists and is pending — but the post has not reached the client.
    expect((await listApprovalQueue(ownerA)).map((a) => a.postId)).toContain(postId);
    expect((await listApprovalQueue(clientA)).map((a) => a.postId)).not.toContain(postId);
  });

  it('shows a Client their own gate once the post reaches them', async () => {
    const postId = await publishablePost({ clientGate: true });
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);
    await decideApproval(
      ownerA,
      (await pendingGate(ownerA, postId)).id,
      { decision: 'APPROVED' },
      fingerprint,
    );

    expect((await listApprovalQueue(clientA)).map((a) => a.postId)).toContain(postId);
  });

  it('filters by stage', async () => {
    const postId = await publishablePost({ clientGate: true });
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);

    expect(await listApprovalQueue(ownerA, { stage: 'INTERNAL' })).toHaveLength(1);
    expect(await listApprovalQueue(ownerA, { stage: 'CLIENT' })).toHaveLength(0);
  });
});

// ── Comments ────────────────────────────────────────────────────────────────

describe('comments', () => {
  it('defaults an internal user comment to INTERNAL', async () => {
    const postId = await publishablePost();
    const comment = await createComment(ownerA, postId, { body: 'Looks fine to me' }, fingerprint);

    expect(comment.visibility).toBe('INTERNAL');
  });

  it('never shows an internal comment to a Client', async () => {
    const postId = await publishablePost({ clientGate: true });
    await createComment(ownerA, postId, { body: 'The client will hate this' }, fingerprint);
    await createComment(
      ownerA,
      postId,
      { body: 'Here is the draft for your review', visibility: 'CLIENT_VISIBLE' },
      fingerprint,
    );

    // Move it to where the client can see the post at all.
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);
    await decideApproval(
      ownerA,
      (await pendingGate(ownerA, postId)).id,
      { decision: 'APPROVED' },
      fingerprint,
    );

    const internalView = await listComments(ownerA, postId);
    const clientView = await listComments(clientA, postId);

    expect(internalView).toHaveLength(2);
    expect(clientView).toHaveLength(1);
    expect(clientView[0]?.body).toBe('Here is the draft for your review');
    expect(clientView.every((c) => c.visibility === 'CLIENT_VISIBLE')).toBe(true);
  });

  it('forces a Client comment to be client-visible whatever they asked for', async () => {
    const postId = await publishablePost({ clientGate: true });
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);
    await decideApproval(
      ownerA,
      (await pendingGate(ownerA, postId)).id,
      { decision: 'APPROVED' },
      fingerprint,
    );

    const comment = await createComment(
      clientA,
      postId,
      { body: 'Can we change the photo?', visibility: 'INTERNAL' },
      fingerprint,
    );

    expect(comment.visibility).toBe('CLIENT_VISIBLE');
  });

  it('refuses a Client replying into an internal thread', async () => {
    const postId = await publishablePost({ clientGate: true });
    const internal = await createComment(ownerA, postId, { body: 'internal note' }, fingerprint);

    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);
    await decideApproval(
      ownerA,
      (await pendingGate(ownerA, postId)).id,
      { decision: 'APPROVED' },
      fingerprint,
    );

    await expect(
      createComment(clientA, postId, { body: 'me too', parentId: internal.id }, fingerprint),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a client-visible reply on an internal thread', async () => {
    const postId = await publishablePost();
    const internal = await createComment(ownerA, postId, { body: 'internal note' }, fingerprint);

    await expect(
      createComment(
        ownerA,
        postId,
        { body: 'oops', parentId: internal.id, visibility: 'CLIENT_VISIBLE' },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('drops a mention of someone outside the organization', async () => {
    const postId = await publishablePost();
    const comment = await createComment(
      ownerA,
      postId,
      { body: 'ping', mentionedUserIds: [CREATOR_A, OWNER_B] },
      fingerprint,
    );

    expect(comment.mentionedUserIds).toEqual([CREATOR_A]);
  });

  it('lets only the author edit or delete', async () => {
    const postId = await publishablePost();
    const comment = await createComment(ownerA, postId, { body: 'mine' }, fingerprint);

    await expect(
      updateComment(creatorA, comment.id, 'not mine', fingerprint),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteComment(creatorA, comment.id, fingerprint)).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    const edited = await updateComment(ownerA, comment.id, 'still mine', fingerprint);
    expect(edited.body).toBe('still mine');
  });

  it('resolves a thread once', async () => {
    const postId = await publishablePost();
    const comment = await createComment(ownerA, postId, { body: 'question' }, fingerprint);

    const resolved = await resolveComment(ownerA, comment.id, fingerprint);
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolvedById).toBe(OWNER_A);

    await expect(resolveComment(ownerA, comment.id, fingerprint)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('hides another tenant comment behind a 404', async () => {
    const postId = await publishablePost();
    const comment = await createComment(ownerA, postId, { body: 'ours' }, fingerprint);

    await expect(updateComment(ownerB, comment.id, 'defaced', fingerprint)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(listComments(ownerB, postId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('hides an internal comment behind a 404 for a Client, not a 403', async () => {
    const postId = await publishablePost({ clientGate: true });
    const internal = await createComment(ownerA, postId, { body: 'internal' }, fingerprint);

    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);
    await decideApproval(
      ownerA,
      (await pendingGate(ownerA, postId)).id,
      { decision: 'APPROVED' },
      fingerprint,
    );

    // A 403 would confirm it exists. It has to be indistinguishable from absent.
    await expect(resolveComment(clientA, internal.id, fingerprint)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
