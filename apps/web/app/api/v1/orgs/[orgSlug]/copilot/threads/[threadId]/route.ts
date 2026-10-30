import { z } from 'zod';
import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { deleteThread, getThread } from '@/features/copilot/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; threadId: string };

/** One of the person's own Copilot threads (D-109). */
export const GET = withAuth<Params>(
  { name: 'GET /api/v1/orgs/{orgSlug}/copilot/threads/{threadId}' },
  async ({ ctx, params }) =>
    jsonOk({ thread: await getThread(ctx, z.string().uuid().parse(params.threadId)) }),
);

/** Delete it, and the history the model would have been shown. */
export const DELETE = withAuth<Params>(
  { name: 'DELETE /api/v1/orgs/{orgSlug}/copilot/threads/{threadId}' },
  async ({ ctx, params }) => {
    await deleteThread(ctx, z.string().uuid().parse(params.threadId));
    return jsonOk({ deleted: true });
  },
);
