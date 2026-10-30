import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { listGrants } from '@/features/agent/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * AI apps with access (D-109 §6): the person's own, or everyone's for an Owner
 * or Admin. A person's act — an agent is refused by `listGrants`.
 */
export const GET = withAuth<Params>(
  { name: 'GET /api/v1/orgs/{orgSlug}/agent-grants' },
  async ({ ctx }) => jsonOk({ grants: await listGrants(ctx) }),
);
