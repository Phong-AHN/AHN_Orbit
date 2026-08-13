import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { autosavePostSchema, PROTECTED_POST_FIELDS } from '@/features/posts/contracts';
import { postResourceScope } from '@/features/posts/route-scope';
import { autosavePost } from '@/features/posts/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; postId: string };

/**
 * Debounced save of the master copy.
 *
 * Carries the same permission and edit lock as a deliberate save — a keystroke
 * timer is not a licence to bypass either. Returns the new `updatedAt`, which
 * the client sends back on the next call so a second editor's changes are
 * detected rather than silently overwritten.
 */
export const POST = withAuth<Params>(
  {
    permission: 'post:update',
    resource: postResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/posts/{postId}/autosave',
  },
  async ({ request, ctx, params }) => {
    const input = await readJsonBody(request, autosavePostSchema, {
      alsoForbid: PROTECTED_POST_FIELDS,
    });

    return jsonOk(await autosavePost(ctx, params.postId, input));
  },
);
