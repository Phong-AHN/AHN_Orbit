import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { getPlanOverview } from '@/features/billing/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * The organization's plan, its limits, what it uses, and any plan change
 * waiting for an answer (docs/API.md §2.13, D-116).
 *
 * `billing:read`: Owners and Admins. An Admin can see the plan but not ask to
 * change it.
 */
export const GET = withAuth<Params>(
  { permission: 'billing:read', name: 'GET /api/v1/orgs/{orgSlug}/billing/subscription' },
  async ({ ctx }) => jsonOk({ subscription: await getPlanOverview(ctx) }),
);
