import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { replySchema } from '@/features/community/contracts';
import { commentResourceScope } from '@/features/community/route-scope';
import { replyToComment } from '@/features/community/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; commentId: string };

/**
 * Answer a comment, as the brand, in public (docs/API.md §2.15).
 *
 * The most consequential write in this feature and the only one that reaches a
 * platform: it puts words on a client's channel under the client's name, with
 * no approval gate in front of it. So it carries a permission an **Approver
 * does not hold** — they review, they do not publish — resolved against the
 * comment's own brand because the grant is brand-scoped for two roles.
 *
 * The comment is addressed by Orbit's uuid, never the platform's id. A body
 * carrying `externalId` would let a caller post a comment on any object their
 * token can reach, which is the whole platform rather than this tenant's post.
 */
export const POST = withAuth<Params>(
  {
    permission: 'comment:reply',
    resource: commentResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/community/{commentId}/reply',
  },
  async ({ request, ctx, params }) => {
    const input = replySchema.parse(await request.json());

    return jsonOk({
      reply: await replyToComment(ctx, params.commentId, input, requestFingerprint(request)),
    });
  },
);
