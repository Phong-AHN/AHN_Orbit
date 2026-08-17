import { accessibleWorkspaceIds, isUserPrincipal, ForbiddenError } from '@orbit/core';
import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { listMyTasks } from '@/features/tasks/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * "What is on my plate."
 *
 * The assignee is the session's, never a query parameter — a filter the caller
 * supplies would be a way to read another person's workload, and the answer is
 * only ever about the person asking.
 */
export const GET = withAuth<Params>(
  { permission: 'task:read', name: 'GET /api/v1/orgs/{orgSlug}/tasks/mine' },
  async ({ ctx }) => {
    if (!isUserPrincipal(ctx.principal)) {
      throw new ForbiddenError('Only a user has a task list');
    }

    return jsonOk({
      tasks: await listMyTasks(ctx, ctx.principal.userId, accessibleWorkspaceIds(ctx)),
    });
  },
);
