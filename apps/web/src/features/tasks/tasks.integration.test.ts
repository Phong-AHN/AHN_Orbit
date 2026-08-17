import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, type TenantContext } from '@orbit/core';
import { devIdentityProvider, resolveTenantContext, resolveUser } from '@orbit/auth';
import { platformDb, withTenant } from '@orbit/db';
import {
  assertNoBlockingTasks,
  createTask,
  deleteTask,
  listMyTasks,
  listTasks,
  updateTask,
} from './service';

/**
 * Production tasks against the real database (SRS §11).
 *
 * The cases that matter are the ones a unit test cannot prove: that a task from
 * another organization is invisible even with its exact id, that the timestamps
 * are derived rather than accepted, and — most of all — that a blocking task
 * *refuses* a transition rather than performing one. A pipeline that moved posts
 * would be a second state machine, and the whole design rests on there being
 * exactly one.
 */

const ORG_A = '018fd100-0000-7000-8000-0000d1000001';
const ORG_B = '018fd200-0000-7000-8000-0000d2000001';
const WS_A = '018fd100-0000-7000-8000-0000d1000002';
const BRAND_A = '018fd100-0000-7000-8000-0000d1000003';
const WS_B = '018fd200-0000-7000-8000-0000d2000002';
const BRAND_B = '018fd200-0000-7000-8000-0000d2000003';

const fingerprint = { ip: '127.0.0.1', userAgent: 'vitest' };

let ctxA: TenantContext;
let ctxB: TenantContext;
let userA = '';
let postA = '';
let postB = '';

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

  const { ctx } = await resolveTenantContext(user, org, 'itest-tasks');
  return { ctx, userId: user.id };
}

beforeAll(async () => {
  const a = await seed(ORG_A, WS_A, BRAND_A, 'tasks-a', 'owner@tasks-a.test');
  const b = await seed(ORG_B, WS_B, BRAND_B, 'tasks-b', 'owner@tasks-b.test');
  ctxA = a.ctx;
  ctxB = b.ctx;
  userA = a.userId;
});

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await platformDb.user.deleteMany({ where: { email: { endsWith: '.test' } } });
});

beforeEach(async () => {
  await platformDb.productionTask.deleteMany({
    where: { organizationId: { in: [ORG_A, ORG_B] } },
  });
  await platformDb.post.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });

  const a = await platformDb.post.create({
    data: {
      organizationId: ORG_A,
      workspaceId: WS_A,
      brandId: BRAND_A,
      body: 'Post in A',
      status: 'DRAFT',
    },
  });
  const b = await platformDb.post.create({
    data: {
      organizationId: ORG_B,
      workspaceId: WS_B,
      brandId: BRAND_B,
      body: 'Post in B',
      status: 'DRAFT',
    },
  });
  postA = a.id;
  postB = b.id;
});

describe('creating tasks', () => {
  it('adds a stage to a post', async () => {
    const task = await createTask(ctxA, postA, { stage: 'DESIGN', blocking: false }, fingerprint);

    expect(task.stage).toBe('DESIGN');
    expect(task.state).toBe('TODO');
    expect(task.startedAt).toBeNull();
    expect(task.completedAt).toBeNull();
  });

  it('refuses the same stage twice, with a sentence rather than a constraint error', async () => {
    await createTask(ctxA, postA, { stage: 'DESIGN', blocking: false }, fingerprint);

    await expect(
      createTask(ctxA, postA, { stage: 'DESIGN', blocking: false }, fingerprint),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('does not find a post from another tenant, by exact id', async () => {
    await expect(
      createTask(ctxA, postB, { stage: 'DESIGN', blocking: false }, fingerprint),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses an assignee who is not a member of this organization', async () => {
    const outsider = await platformDb.user.findFirstOrThrow({
      where: { email: 'owner@tasks-b.test' },
    });

    await expect(
      createTask(
        ctxA,
        postA,
        { stage: 'DESIGN', assigneeId: outsider.id, blocking: false },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('writes an audit row', async () => {
    await createTask(ctxA, postA, { stage: 'COPYWRITING', blocking: true }, fingerprint);

    const entry = await platformDb.auditLog.findFirst({
      where: { organizationId: ORG_A, action: 'task.created' },
    });
    expect(entry).not.toBeNull();
  });
});

describe('updating tasks', () => {
  /**
   * A client that could set `completedAt` could report work finished at a time
   * it was not, and the pipeline's only value is that its history is true.
   */
  it('derives the timestamps from the transition rather than accepting them', async () => {
    const task = await createTask(ctxA, postA, { stage: 'DESIGN', blocking: false }, fingerprint);

    const started = await updateTask(ctxA, task.id, { state: 'IN_PROGRESS' }, fingerprint);
    expect(started.startedAt).toBeInstanceOf(Date);
    expect(started.completedAt).toBeNull();

    const done = await updateTask(ctxA, task.id, { state: 'DONE' }, fingerprint);
    expect(done.completedAt).toBeInstanceOf(Date);

    // Reopening clears the completion; it did not, in fact, complete.
    const reopened = await updateTask(ctxA, task.id, { state: 'IN_PROGRESS' }, fingerprint);
    expect(reopened.completedAt).toBeNull();
  });

  it('does not find a task from another tenant', async () => {
    const theirs = await createTask(ctxB, postB, { stage: 'DESIGN', blocking: false }, fingerprint);

    await expect(
      updateTask(ctxA, theirs.id, { state: 'DONE' }, fingerprint),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('my tasks', () => {
  it('lists open work assigned to one person and drops what is finished', async () => {
    const mine = await createTask(
      ctxA,
      postA,
      { stage: 'DESIGN', assigneeId: userA, blocking: false },
      fingerprint,
    );
    await createTask(
      ctxA,
      postA,
      { stage: 'COPYWRITING', assigneeId: userA, blocking: false },
      fingerprint,
    );

    expect(await listMyTasks(ctxA, userA, 'ALL')).toHaveLength(2);

    await updateTask(ctxA, mine.id, { state: 'DONE' }, fingerprint);
    expect(await listMyTasks(ctxA, userA, 'ALL')).toHaveLength(1);
  });

  it('is narrowed to the workspaces the person can reach', async () => {
    await createTask(
      ctxA,
      postA,
      { stage: 'DESIGN', assigneeId: userA, blocking: false },
      fingerprint,
    );

    expect(await listMyTasks(ctxA, userA, [])).toHaveLength(0);
  });
});

describe('blocking a post', () => {
  /**
   * The one place the pipeline touches the state machine, and it touches it as
   * a *refusal*. If a task could advance a post instead, there would be two
   * things writing statuses and no single authority over the post lifecycle.
   */
  it('refuses to leave DRAFT while a blocking task is open, and never moves the post itself', async () => {
    await createTask(ctxA, postA, { stage: 'DESIGN', blocking: true }, fingerprint);

    await expect(withTenant(ctxA, (db) => assertNoBlockingTasks(db, postA))).rejects.toBeInstanceOf(
      ConflictError,
    );

    const after = await platformDb.post.findFirstOrThrow({ where: { id: postA } });
    expect(after.status).toBe('DRAFT');
  });

  it('names the stages that are holding it', async () => {
    await createTask(ctxA, postA, { stage: 'DESIGN', blocking: true }, fingerprint);
    await createTask(ctxA, postA, { stage: 'COPYWRITING', blocking: true }, fingerprint);

    // `userMessage` is what the person reads; `message` is for the log. The
    // stages have to be in the half they will actually see.
    const error = await withTenant(ctxA, (db) => assertNoBlockingTasks(db, postA)).then(
      () => null,
      (e: unknown) => e as ConflictError,
    );

    expect(error).toBeInstanceOf(ConflictError);
    expect(error?.userMessage).toMatch(/design/i);
    expect(error?.userMessage).toMatch(/copywriting/i);
  });

  it('stops blocking once the task is done', async () => {
    const task = await createTask(ctxA, postA, { stage: 'DESIGN', blocking: true }, fingerprint);
    await updateTask(ctxA, task.id, { state: 'DONE' }, fingerprint);

    await expect(
      withTenant(ctxA, (db) => assertNoBlockingTasks(db, postA)),
    ).resolves.toBeUndefined();
  });

  it('a non-blocking task holds nothing', async () => {
    await createTask(ctxA, postA, { stage: 'DESIGN', blocking: false }, fingerprint);

    await expect(
      withTenant(ctxA, (db) => assertNoBlockingTasks(db, postA)),
    ).resolves.toBeUndefined();
  });
});

describe('deleting', () => {
  it('removes the task and leaves the audit row behind', async () => {
    const task = await createTask(ctxA, postA, { stage: 'DESIGN', blocking: false }, fingerprint);

    await deleteTask(ctxA, task.id, fingerprint);

    expect(await listTasks(ctxA, postA)).toHaveLength(0);
    expect(
      await platformDb.auditLog.findFirst({
        where: { organizationId: ORG_A, action: 'task.deleted' },
      }),
    ).not.toBeNull();
  });
});
