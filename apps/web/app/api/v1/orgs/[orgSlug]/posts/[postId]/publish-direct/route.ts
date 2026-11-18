import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { PROTECTED_POST_FIELDS } from '@/features/posts/contracts';
import { postResourceScope } from '@/features/posts/route-scope';
import { publishDirectSchema } from '@/features/publishing/contracts';
import { publishWithoutReview } from '@/features/publishing/direct';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; postId: string };

/**
 * Publish a draft now, or schedule it, without the review steps (D-127).
 *
 * Only for a post in a workspace with no client — the agency's own accounts.
 * No permission is declared here, for the reason the schedule route declares
 * none: the steps are the existing transitions, and the state machine names
 * and enforces the right for each. Publishing now additionally needs
 * `post:publish_now`, which the service checks before the first step, so a
 * refusal leaves the post a draft.
 */
export const POST = withAuth<Params>(
  {
    resource: postResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/posts/{postId}/publish-direct',
  },
  async ({ request, ctx, params }) => {
    const input = await readJsonBody(request, publishDirectSchema, {
      alsoForbid: PROTECTED_POST_FIELDS,
    });

    return jsonOk(
      await publishWithoutReview(ctx, params.postId, input, requestFingerprint(request)),
    );
  },
);
