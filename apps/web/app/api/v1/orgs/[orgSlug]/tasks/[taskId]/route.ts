import { NextResponse } from 'next/server';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { updateTaskSchema } from '@/features/tasks/contracts';
import { deleteTask, updateTask } from '@/features/tasks/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; taskId: string };

export const PATCH = withAuth<Params>(
  { permission: 'task:update', name: 'PATCH /api/v1/orgs/{orgSlug}/tasks/{taskId}' },
  async ({ request, ctx, params }) => {
    const input = await readJsonBody(request, updateTaskSchema);
    const task = await updateTask(ctx, params.taskId, input, requestFingerprint(request));
    return jsonOk({ task });
  },
);

export const DELETE = withAuth<Params>(
  { permission: 'task:delete', name: 'DELETE /api/v1/orgs/{orgSlug}/tasks/{taskId}' },
  async ({ request, ctx, params }) => {
    await deleteTask(ctx, params.taskId, requestFingerprint(request));
    // 204, matching the post delete route: nothing survives worth returning.
    return new NextResponse(null, { status: 204 });
  },
);
