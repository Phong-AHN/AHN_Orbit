import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { markAllReadForUser } from '@/features/notifications/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * Clear the bell.
 *
 * Scoped to the caller by the same rule as everything else here: the `where`
 * carries their user id, so "all" means all of *theirs*. There is no body, and
 * therefore nothing a caller could widen it with.
 */
export const POST = withAuth<Params>(
  { name: 'POST /api/v1/orgs/{orgSlug}/notifications/read-all' },
  async ({ ctx }) => {
    const marked = await markAllReadForUser(ctx);
    return jsonOk({ marked, unread: 0 });
  },
);
