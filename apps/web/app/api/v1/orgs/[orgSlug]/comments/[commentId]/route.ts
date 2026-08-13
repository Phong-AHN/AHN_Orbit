import { NextResponse } from 'next/server';
import type { TenantContext } from '@orbit/core';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { PROTECTED_COMMENT_FIELDS, updateCommentSchema } from '@/features/approvals/contracts';
import { commentScope, deleteComment, updateComment } from '@/features/comments/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; commentId: string };

/**
 * Scope for the policy check.
 *
 * The lookup itself already applies the Client visibility narrowing, so an
 * internal comment is a 404 here — a Client cannot learn it exists, let alone
 * act on it.
 */
async function scope({ params, ctx }: { params: Params; ctx: TenantContext }) {
  const post = await commentScope(ctx, params.commentId);
  return {
    workspaceId: post.workspaceId,
    brandId: post.brandId,
    createdById: post.createdById,
    status: post.status,
  };
}

export const PATCH = withAuth<Params>(
  {
    permission: 'comment:create',
    resource: scope,
    name: 'PATCH /api/v1/orgs/{orgSlug}/comments/{commentId}',
  },
  async ({ request, ctx, params }) => {
    const { body } = await readJsonBody(request, updateCommentSchema, {
      alsoForbid: PROTECTED_COMMENT_FIELDS,
    });

    return jsonOk({
      comment: await updateComment(ctx, params.commentId, body, requestFingerprint(request)),
    });
  },
);

export const DELETE = withAuth<Params>(
  {
    permission: 'comment:create',
    resource: scope,
    name: 'DELETE /api/v1/orgs/{orgSlug}/comments/{commentId}',
  },
  async ({ request, ctx, params }) => {
    await deleteComment(ctx, params.commentId, requestFingerprint(request));
    return new NextResponse(null, { status: 204 });
  },
);
