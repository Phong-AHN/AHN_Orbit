import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { parseRange } from '@/features/analytics/range';
import { listPostAnalytics } from '@/features/analytics/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * Per-post results (SRS §18, docs/API.md §2.9).
 *
 * Read-only, and reads only stored rows — nothing here calls a provider. The
 * cadence that decides when numbers refresh lives in the worker; a request that
 * could trigger a Graph call would put Meta's per-app quota, which publishing
 * shares, behind whoever reloads the page.
 *
 * A Content Creator holds `analytics:read` at `OWN` scope so they can learn
 * from their own results (**O3**). That narrowing is applied here from the
 * session, never from a query parameter — a client that could name an author
 * could name somebody else's.
 */
export const GET = withAuth<Params>(
  {
    permission: 'analytics:read',
    resource: ({ request }) => {
      const params = new URL(request.url).searchParams;
      const workspaceId = params.get('workspaceId');
      const brandId = params.get('brandId');
      return {
        ...(workspaceId ? { workspaceId } : {}),
        ...(brandId ? { brandId } : {}),
      };
    },
    name: 'GET /api/v1/orgs/{orgSlug}/analytics/posts',
  },
  async ({ request, ctx }) => {
    const params = new URL(request.url).searchParams;
    const range = parseRange(params);

    const grant = ctx.principal.kind === 'USER' ? ctx.principal.organizationRole : null;
    const ownOnly = grant === 'CONTENT_CREATOR';

    const workspaceId = params.get('workspaceId');
    const brandId = params.get('brandId');
    const limit = Number.parseInt(params.get('limit') ?? '', 10);

    return jsonOk({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      posts: await listPostAnalytics(ctx, range, {
        ...(workspaceId ? { workspaceId } : {}),
        ...(brandId ? { brandId } : {}),
        ...(ownOnly && ctx.principal.kind === 'USER' ? { authoredBy: ctx.principal.userId } : {}),
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      }),
    });
  },
);
