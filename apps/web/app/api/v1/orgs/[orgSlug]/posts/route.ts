import {
  accessibleWorkspaceIds,
  isUserPrincipal,
  POST_STATUSES,
  type PostStatus,
} from '@orbit/core';
import { CLIENT_VISIBLE_STATUSES } from '@orbit/rbac';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { createPostSchema, PROTECTED_POST_FIELDS } from '@/features/posts/contracts';
import { createPost, listPosts } from '@/features/posts/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

function isPostStatus(value: string | null): value is PostStatus {
  return value !== null && (POST_STATUSES as readonly string[]).includes(value);
}

export const GET = withAuth<Params>(
  {
    permission: 'post:read',
    // A workspace-scoped grant needs to know which workspace is being asked
    // about; without it the policy engine denies with MISSING_SCOPE_INFORMATION
    // and the list below narrows to the accessible set anyway.
    resource: ({ request }) => {
      const url = new URL(request.url);
      const workspaceId = url.searchParams.get('workspaceId');
      const brandId = url.searchParams.get('brandId');
      return {
        ...(workspaceId ? { workspaceId } : {}),
        ...(brandId ? { brandId } : {}),
      };
    },
    name: 'GET /api/v1/orgs/{orgSlug}/posts',
  },
  async ({ request, ctx }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const workspaceId = url.searchParams.get('workspaceId');
    const brandId = url.searchParams.get('brandId');

    // A Client only ever sees content that has reached them. The permitted set
    // comes from the RBAC matrix, not from anything the request supplied.
    const isClient = isUserPrincipal(ctx.principal) && ctx.principal.organizationRole === 'CLIENT';

    return jsonOk({
      posts: await listPosts(ctx, {
        ...(workspaceId ? { workspaceId } : {}),
        ...(brandId ? { brandId } : {}),
        ...(isPostStatus(status) ? { status } : {}),
        ...(isClient ? { visibleStatuses: CLIENT_VISIBLE_STATUSES } : {}),
        accessibleWorkspaces: accessibleWorkspaceIds(ctx),
      }),
    });
  },
);

export const POST = withAuth<Params>(
  {
    permission: 'post:create',
    // The body is read twice: once here, unvalidated, only to locate the
    // workspace the permission applies to, and again in the handler where it is
    // parsed properly. Authorization must precede the real read, not follow it.
    resource: async ({ request }) => {
      const body: unknown = await request
        .clone()
        .json()
        .catch(() => ({}));
      const parsed = createPostSchema.partial().safeParse(body);
      if (!parsed.success || !parsed.data.workspaceId) return {};
      return {
        workspaceId: parsed.data.workspaceId,
        ...(parsed.data.brandId ? { brandId: parsed.data.brandId } : {}),
      };
    },
    name: 'POST /api/v1/orgs/{orgSlug}/posts',
  },
  async ({ request, ctx }) => {
    const input = await readJsonBody(request, createPostSchema, {
      alsoForbid: PROTECTED_POST_FIELDS,
    });

    return jsonOk(
      { post: await createPost(ctx, input, requestFingerprint(request)) },
      { status: 201 },
    );
  },
);
