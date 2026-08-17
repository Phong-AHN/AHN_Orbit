import { accessibleWorkspaceIds, clock, isUserPrincipal, type TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';

/**
 * "Your work" — the part of the dashboard that is about *you* (SRS §20).
 *
 * The organization dashboard answers "what needs attention"; this answers "what
 * needs attention **from me**", and for a Content Creator that is the whole
 * product. Without it the dashboard shows a creator the agency's aggregate
 * numbers, most of which they cannot act on, which is what makes a role-aware
 * product feel like a generic one with things missing.
 *
 * Everything here is scoped twice over: the tenant client bounds the
 * organization, and `accessibleWorkspaceIds` bounds a workspace-scoped role, so
 * a creator's own list cannot reach a client they do not work on.
 */

export interface MyTask {
  id: string;
  stage: string;
  state: string;
  dueAt: Date | null;
  blocking: boolean;
  overdue: boolean;
  post: { id: string; title: string | null; body: string };
}

export interface MyDraft {
  id: string;
  title: string | null;
  body: string;
  status: string;
  updatedAt: Date;
}

export interface MyWork {
  tasks: MyTask[];
  drafts: MyDraft[];
  /** Posts this person authored that a reviewer sent back. */
  changesRequested: MyDraft[];
}

const POST_FIELDS = { id: true, title: true, body: true, status: true, updatedAt: true } as const;

export async function myWork(ctx: TenantContext): Promise<MyWork> {
  if (!isUserPrincipal(ctx.principal)) {
    return { tasks: [], drafts: [], changesRequested: [] };
  }

  const userId = ctx.principal.userId;
  const accessible = accessibleWorkspaceIds(ctx);
  const now = clock.now();

  const workspaceFilter = accessible === 'ALL' ? {} : { workspaceId: { in: [...accessible] } };

  return withTenant(ctx, async (db) => {
    const [tasks, drafts, changesRequested] = await Promise.all([
      db.productionTask.findMany({
        where: {
          assigneeId: userId,
          state: { not: 'DONE' },
          post: { deletedAt: null, ...workspaceFilter },
        },
        select: {
          id: true,
          stage: true,
          state: true,
          dueAt: true,
          blocking: true,
          post: { select: { id: true, title: true, body: true } },
        },
        // Soonest due first, and undated last — a task with a date is a
        // commitment and a task without one is a note.
        orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        take: 10,
      }),

      db.post.findMany({
        where: {
          deletedAt: null,
          createdById: userId,
          status: 'DRAFT',
          ...workspaceFilter,
        },
        select: POST_FIELDS,
        orderBy: { updatedAt: 'desc' },
        take: 5,
      }),

      // The one that matters most: a post sent back is waiting on this person
      // and nobody else, and it is the easiest thing in the product to forget.
      db.post.findMany({
        where: {
          deletedAt: null,
          createdById: userId,
          status: 'CHANGES_REQUESTED',
          ...workspaceFilter,
        },
        select: POST_FIELDS,
        orderBy: { updatedAt: 'desc' },
        take: 5,
      }),
    ]);

    return {
      tasks: tasks.map((task) => ({
        ...task,
        overdue: task.dueAt !== null && task.dueAt < now,
      })),
      drafts,
      changesRequested,
    };
  });
}
