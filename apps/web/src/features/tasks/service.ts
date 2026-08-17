import { ConflictError, NotFoundError, clock, type TenantContext } from '@orbit/core';
import { withTenant, type TenantDb } from '@orbit/db';
import { audit, type AuditInput } from '@/server/audit';
import type { CreateTaskInput, UpdateTaskInput } from './contracts';

/**
 * Production tasks (SRS §11).
 *
 * The pipeline an agency actually runs — copywriting, design, review — sitting
 * beside the post rather than inside it. The schema has existed since T0.3; this
 * is the layer that makes it usable.
 *
 * **Tasks do not move posts.** The post state machine is the only thing that
 * changes a status, and nothing here calls it. What a task can do is *hold* a
 * post: a blocking task that is not DONE stops the post leaving DRAFT, checked
 * by `assertNoBlockingTasks` at the transition. That is the one place the two
 * systems touch, and it is a refusal rather than a transition — which keeps the
 * state machine the single authority (docs/DECISIONS.md, D-002 reasoning).
 */

const TASK_SELECT = {
  id: true,
  postId: true,
  stage: true,
  state: true,
  assigneeId: true,
  dueAt: true,
  blocking: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  assignee: { select: { id: true, name: true, email: true } },
} as const;

/** Scoped, so a post id from another tenant is simply not found. */
async function requirePost(db: TenantDb, postId: string) {
  const post = await db.post.findFirst({
    where: { id: postId, deletedAt: null },
    select: { id: true, workspaceId: true, brandId: true },
  });
  if (!post) throw new NotFoundError('Post');
  return post;
}

/**
 * An assignee must be a member of this organization.
 *
 * `User` deliberately spans organizations, so there is no composite foreign key
 * to lean on here — the membership lookup is the check (docs/DECISIONS.md,
 * "User references are not tenant-enforceable at the database level").
 */
async function requireAssignable(db: TenantDb, userId: string) {
  const membership = await db.organizationMembership.findFirst({
    where: { userId, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!membership) throw new NotFoundError('User');
}

export async function listTasks(ctx: TenantContext, postId: string) {
  return withTenant(ctx, async (db) => {
    await requirePost(db, postId);

    return db.productionTask.findMany({
      where: { postId },
      select: TASK_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  });
}

/**
 * Every open task assigned to one person, across the workspaces they can reach.
 *
 * This is what makes the pipeline a to-do list rather than a per-post detail:
 * "what is on my plate" is the question a contributor actually asks, and it
 * cannot be answered from a post they have not opened.
 */
export async function listMyTasks(
  ctx: TenantContext,
  userId: string,
  accessible: 'ALL' | readonly string[],
) {
  return withTenant(ctx, (db) =>
    db.productionTask.findMany({
      where: {
        assigneeId: userId,
        state: { not: 'DONE' },
        post: {
          deletedAt: null,
          ...(accessible === 'ALL' ? {} : { workspaceId: { in: [...accessible] } }),
        },
      },
      select: {
        ...TASK_SELECT,
        post: { select: { id: true, title: true, body: true, status: true, workspaceId: true } },
      },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
      take: 100,
    }),
  );
}

export async function createTask(
  ctx: TenantContext,
  postId: string,
  input: CreateTaskInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const post = await requirePost(db, postId);
    if (input.assigneeId) await requireAssignable(db, input.assigneeId);

    // `@@unique([postId, stage])` would refuse this anyway; catching it here
    // turns a constraint violation into a sentence someone can act on.
    const existing = await db.productionTask.findFirst({
      where: { postId, stage: input.stage },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictError('Stage already exists on this post', {
        userMessage: 'That stage is already on this post.',
        context: { postId, stage: input.stage },
      });
    }

    const task = await db.productionTask.create({
      data: {
        organizationId: ctx.organizationId,
        postId,
        stage: input.stage,
        assigneeId: input.assigneeId ?? null,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        blocking: input.blocking,
      },
      select: TASK_SELECT,
    });

    await audit(db, ctx, {
      action: 'task.created',
      resourceType: 'ProductionTask',
      resourceId: task.id,
      workspaceId: post.workspaceId,
      brandId: post.brandId,
      after: { stage: task.stage, blocking: task.blocking, assigneeId: task.assigneeId },
      ...fingerprint,
    });

    return task;
  });
}

export async function updateTask(
  ctx: TenantContext,
  taskId: string,
  input: UpdateTaskInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const task = await db.productionTask.findFirst({
      where: { id: taskId },
      select: { ...TASK_SELECT, post: { select: { workspaceId: true, brandId: true } } },
    });
    if (!task) throw new NotFoundError('Task');

    if (input.assigneeId) await requireAssignable(db, input.assigneeId);

    /**
     * Timestamps are derived, never sent.
     *
     * A client that could set `completedAt` could report work finished at a
     * time it was not, and the pipeline's whole value is that its history is
     * true. So the transition decides: first move out of TODO starts it,
     * arriving at DONE completes it, and leaving DONE clears that again.
     */
    const nextState = input.state ?? task.state;
    const startedAt =
      task.startedAt ?? (nextState !== 'TODO' && task.state === 'TODO' ? clock.now() : null);
    const completedAt =
      nextState === 'DONE'
        ? (task.completedAt ?? clock.now())
        : nextState === task.state
          ? task.completedAt
          : null;

    const updated = await db.productionTask.update({
      where: { id: taskId },
      data: {
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId ?? null } : {}),
        ...(input.dueAt !== undefined ? { dueAt: input.dueAt ? new Date(input.dueAt) : null } : {}),
        ...(input.blocking !== undefined ? { blocking: input.blocking } : {}),
        startedAt,
        completedAt,
      },
      select: TASK_SELECT,
    });

    await audit(db, ctx, {
      action: 'task.updated',
      resourceType: 'ProductionTask',
      resourceId: taskId,
      workspaceId: task.post.workspaceId,
      brandId: task.post.brandId,
      before: { state: task.state, assigneeId: task.assigneeId, blocking: task.blocking },
      after: { state: updated.state, assigneeId: updated.assigneeId, blocking: updated.blocking },
      ...fingerprint,
    });

    return updated;
  });
}

export async function deleteTask(
  ctx: TenantContext,
  taskId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const task = await db.productionTask.findFirst({
      where: { id: taskId },
      select: { id: true, stage: true, post: { select: { workspaceId: true, brandId: true } } },
    });
    if (!task) throw new NotFoundError('Task');

    // A hard delete: a production task is a working note, not a record of what
    // was published. The audit row is what survives.
    await db.productionTask.delete({ where: { id: taskId } });

    await audit(db, ctx, {
      action: 'task.deleted',
      resourceType: 'ProductionTask',
      resourceId: taskId,
      workspaceId: task.post.workspaceId,
      brandId: task.post.brandId,
      before: { stage: task.stage },
      ...fingerprint,
    });
  });
}

/**
 * Refuse to move a post while a blocking task is open.
 *
 * Called from the post transition, and deliberately shaped as a *check* rather
 * than a hook that could change a status: the state machine stays the only
 * thing that writes one.
 */
export async function assertNoBlockingTasks(db: TenantDb, postId: string): Promise<void> {
  const blocking = await db.productionTask.findMany({
    where: { postId, blocking: true, state: { not: 'DONE' } },
    select: { stage: true },
  });

  if (blocking.length === 0) return;

  throw new ConflictError('Blocking production tasks are still open', {
    userMessage: `Finish the blocking ${blocking.length === 1 ? 'task' : 'tasks'} first: ${blocking
      .map((task) => task.stage.toLowerCase().replace('_', ' '))
      .join(', ')}.`,
    context: { postId, stages: blocking.map((task) => task.stage) },
  });
}
