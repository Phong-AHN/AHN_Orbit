import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { commentQuerySchema } from '@/features/community/contracts';
import { listComments, unhandledCount } from '@/features/community/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * The community queue (docs/API.md §2.15).
 *
 * No `resource` on the wrapper and **no permission either**, which needs
 * saying: `comment:read_public` is brand-scoped for a Content Creator and an
 * Approver, so checking it here with an empty scope would deny exactly the
 * people the queue is for (**D-069**). The service authorizes instead — against
 * the filters when they are given, and against each row when one is addressed
 * directly.
 *
 * `withAuth` still runs authentication, tenant resolution and the client
 * refusal first, so the context the service authorizes against is trustworthy.
 */
export const GET = withAuth<Params>(
  { name: 'GET /api/v1/orgs/{orgSlug}/community' },
  async ({ request, ctx }) => {
    const url = new URL(request.url);

    // Parsed rather than read field by field, so an unparseable filter is a
    // 400 with the offending field named instead of a silently ignored one.
    const query = commentQuerySchema.parse(Object.fromEntries(url.searchParams));

    const [comments, unhandled] = await Promise.all([
      listComments(ctx, query),
      unhandledCount(ctx),
    ]);

    return jsonOk({ comments, unhandled });
  },
);
