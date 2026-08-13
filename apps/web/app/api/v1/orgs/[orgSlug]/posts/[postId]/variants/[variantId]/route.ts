import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { PROTECTED_POST_FIELDS, updateVariantSchema } from '@/features/posts/contracts';
import { postResourceScope } from '@/features/posts/route-scope';
import { updateVariant } from '@/features/posts/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; postId: string; variantId: string };

/**
 * Per-account content override. `null` on a field clears the override and the
 * variant inherits the master copy again.
 *
 * Authorization comes from the parent post, and the variant is looked up with
 * `postId` in the filter — so a variant id belonging to a different post, or a
 * different tenant, is a 404 rather than an edit.
 */
export const PATCH = withAuth<Params>(
  {
    permission: 'post:update',
    resource: postResourceScope,
    name: 'PATCH /api/v1/orgs/{orgSlug}/posts/{postId}/variants/{variantId}',
  },
  async ({ request, ctx, params }) => {
    const input = await readJsonBody(request, updateVariantSchema, {
      alsoForbid: PROTECTED_POST_FIELDS,
    });

    return jsonOk({
      variant: await updateVariant(
        ctx,
        params.postId,
        params.variantId,
        input,
        requestFingerprint(request),
      ),
    });
  },
);
