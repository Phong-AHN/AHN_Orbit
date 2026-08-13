import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { PROTECTED_COMMENT_FIELDS, createCommentSchema } from '@/features/approvals/contracts';
import { postResourceScope } from '@/features/posts/route-scope';
import { createComment, listComments } from '@/features/comments/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; postId: string };

/**
 * Read a post's comments.
 *
 * Guarded by `post:read`, not `comment:read_internal` — everyone who can see the
 * post can see *some* comments. Which ones is decided in the service by
 * narrowing the query, so a Client never loads an internal row rather than
 * loading one and being refused it.
 */
export const GET = withAuth<Params>(
  {
    permission: 'post:read',
    resource: postResourceScope,
    name: 'GET /api/v1/orgs/{orgSlug}/posts/{postId}/comments',
  },
  async ({ ctx, params }) => jsonOk({ comments: await listComments(ctx, params.postId) }),
);

export const POST = withAuth<Params>(
  {
    permission: 'comment:create',
    resource: postResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/posts/{postId}/comments',
  },
  async ({ request, ctx, params }) => {
    const input = await readJsonBody(request, createCommentSchema, {
      alsoForbid: PROTECTED_COMMENT_FIELDS,
    });

    return jsonOk(
      { comment: await createComment(ctx, params.postId, input, requestFingerprint(request)) },
      { status: 201 },
    );
  },
);
