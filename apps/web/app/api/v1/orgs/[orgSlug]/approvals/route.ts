import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { approvalQueueQuerySchema } from '@/features/approvals/contracts';
import { listApprovalQueue } from '@/features/approvals/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * The approval queue.
 *
 * Guarded by `post:read` — deciding is a separate right, checked when a decision
 * is actually made. The service narrows the result to the workspaces this
 * principal can reach, and narrows a Client further to posts whose status has
 * reached them, so a pending internal review never appears in the portal.
 */
export const GET = withAuth<Params>(
  {
    permission: 'post:read',
    resource: ({ request }) => {
      const url = new URL(request.url);
      const workspaceId = url.searchParams.get('workspaceId');
      const brandId = url.searchParams.get('brandId');
      return {
        ...(workspaceId ? { workspaceId } : {}),
        ...(brandId ? { brandId } : {}),
      };
    },
    name: 'GET /api/v1/orgs/{orgSlug}/approvals',
  },
  async ({ request, ctx }) => {
    const url = new URL(request.url);
    const filter = approvalQueueQuerySchema.parse({
      stage: url.searchParams.get('stage') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
      workspaceId: url.searchParams.get('workspaceId') ?? undefined,
      brandId: url.searchParams.get('brandId') ?? undefined,
    });

    return jsonOk({ approvals: await listApprovalQueue(ctx, filter) });
  },
);
