import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { postResourceScope } from '@/features/posts/route-scope';
import { createTaskSchema } from '@/features/tasks/contracts';
import { createTask, listTasks } from '@/features/tasks/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; postId: string };

/** The production pipeline for one post (SRS §11). */
export const GET = withAuth<Params>(
  {
    permission: 'task:read',
    resource: postResourceScope,
    name: 'GET /api/v1/orgs/{orgSlug}/posts/{postId}/tasks',
  },
  async ({ ctx, params }) => jsonOk({ tasks: await listTasks(ctx, params.postId) }),
);

export const POST = withAuth<Params>(
  {
    permission: 'task:create',
    resource: postResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/posts/{postId}/tasks',
  },
  async ({ request, ctx, params }) => {
    const input = await readJsonBody(request, createTaskSchema);
    const task = await createTask(ctx, params.postId, input, requestFingerprint(request));
    return jsonOk({ task }, { status: 201 });
  },
);
