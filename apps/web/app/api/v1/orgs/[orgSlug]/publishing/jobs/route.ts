import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { publishingLogQuerySchema } from '@/features/publishing/contracts';
import { listPublishingJobs, publishingSummary } from '@/features/publishing/logs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * The publishing job list (API §2.8).
 *
 * Guarded by `post:read` and narrowed again in the service to the workspaces
 * this principal can reach — so an operator sees the jobs behind posts they
 * could already open, and nothing more.
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
    name: 'GET /api/v1/orgs/{orgSlug}/publishing/jobs',
  },
  async ({ request, ctx }) => {
    const url = new URL(request.url);

    const query = publishingLogQuerySchema.parse({
      state: url.searchParams.get('state') ?? undefined,
      workspaceId: url.searchParams.get('workspaceId') ?? undefined,
      brandId: url.searchParams.get('brandId') ?? undefined,
      socialAccountId: url.searchParams.get('socialAccountId') ?? undefined,
      needsReviewOnly: url.searchParams.get('needsReviewOnly') ?? undefined,
      failedOnly: url.searchParams.get('failedOnly') ?? undefined,
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
    });

    // The window arrives as ISO strings and the service works in instants.
    const { from, to, ...rest } = query;

    const [page, summary] = await Promise.all([
      listPublishingJobs(ctx, {
        ...rest,
        ...(from ? { from: new Date(from) } : {}),
        ...(to ? { to: new Date(to) } : {}),
      }),
      publishingSummary(ctx),
    ]);

    return jsonOk({ ...page, summary });
  },
);
