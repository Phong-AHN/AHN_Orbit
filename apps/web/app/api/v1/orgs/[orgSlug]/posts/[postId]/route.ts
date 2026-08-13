import { NextResponse } from 'next/server';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { PROTECTED_POST_FIELDS, updatePostSchema } from '@/features/posts/contracts';
import { postResourceScope } from '@/features/posts/route-scope';
import { deletePost, getPost, updatePost } from '@/features/posts/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; postId: string };

export const GET = withAuth<Params>(
  {
    permission: 'post:read',
    resource: postResourceScope,
    name: 'GET /api/v1/orgs/{orgSlug}/posts/{postId}',
  },
  async ({ ctx, params }) => jsonOk({ post: await getPost(ctx, params.postId) }),
);

export const PATCH = withAuth<Params>(
  {
    permission: 'post:update',
    resource: postResourceScope,
    name: 'PATCH /api/v1/orgs/{orgSlug}/posts/{postId}',
  },
  async ({ request, ctx, params }) => {
    const input = await readJsonBody(request, updatePostSchema, {
      alsoForbid: PROTECTED_POST_FIELDS,
    });

    return jsonOk({
      post: await updatePost(ctx, params.postId, input, requestFingerprint(request)),
    });
  },
);

export const DELETE = withAuth<Params>(
  {
    permission: 'post:delete',
    resource: postResourceScope,
    name: 'DELETE /api/v1/orgs/{orgSlug}/posts/{postId}',
  },
  async ({ request, ctx, params }) => {
    await deletePost(ctx, params.postId, requestFingerprint(request));
    return new NextResponse(null, { status: 204 });
  },
);
