import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { bulkPostActionSchema } from '@/features/posts/contracts';
import { bulkPostAction } from '@/features/posts/bulk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * One action on several posts: `delete`, `duplicate` or `cancel`.
 *
 * No `permission` is declared here, as on `/transition`: which right applies
 * depends on the action and on each post — its workspace, its author, its
 * status — so every post is checked on its own inside `bulkPostAction`, exactly
 * as its single-post route would check it. The answer is per post.
 */
export const POST = withAuth<Params>(
  { name: 'POST /api/v1/orgs/{orgSlug}/posts/bulk' },
  async ({ request, ctx }) => {
    const input = await readJsonBody(request, bulkPostActionSchema);
    return jsonOk(await bulkPostAction(ctx, input, requestFingerprint(request)));
  },
);
