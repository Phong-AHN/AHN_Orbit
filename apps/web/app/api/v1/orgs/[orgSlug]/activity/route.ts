import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { listActivity } from '@/features/activity/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * The audit trail, read-only.
 *
 * There is no POST, PATCH, or DELETE here and there should never be one: the
 * log is written by the services that perform the actions, and a trail that
 * accepts writes from the outside is not evidence of anything.
 */
export const GET = withAuth<Params>(
  {
    permission: 'audit:read',
    resource: ({ request }) => {
      const workspaceId = new URL(request.url).searchParams.get('workspaceId');
      return workspaceId ? { workspaceId } : {};
    },
    name: 'GET /api/v1/orgs/{orgSlug}/activity',
  },
  async ({ request, ctx }) => {
    const params = new URL(request.url).searchParams;
    const limit = Number.parseInt(params.get('limit') ?? '', 10);

    return jsonOk(
      await listActivity(ctx, {
        ...(params.get('workspaceId') ? { workspaceId: params.get('workspaceId')! } : {}),
        ...(params.get('resourceId') ? { resourceId: params.get('resourceId')! } : {}),
        ...(params.get('resourceType') ? { resourceType: params.get('resourceType')! } : {}),
        ...(params.get('before') ? { before: params.get('before')! } : {}),
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      }),
    );
  },
);
