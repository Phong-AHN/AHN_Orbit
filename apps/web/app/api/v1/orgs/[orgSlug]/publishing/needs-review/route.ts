import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { listNeedsReview } from '@/features/publishing/logs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * Publishes parked awaiting a human decision.
 *
 * The queue an operator actually works from. A variant reaches `NEEDS_REVIEW`
 * when its outcome could not be established and nothing automated will touch it
 * again (decision D-027) — so if nobody looks here, it stays that way.
 */
export const GET = withAuth<Params>(
  { permission: 'post:read', name: 'GET /api/v1/orgs/{orgSlug}/publishing/needs-review' },
  async ({ ctx }) => jsonOk({ variants: await listNeedsReview(ctx) }),
);
