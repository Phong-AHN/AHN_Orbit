import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { listMyActions } from '@/features/agent/actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * The signed-in person's own agent actions (D-109 §5). No permission beyond
 * membership: everyone may see what their own agent prepared, and nobody
 * anyone else's. An agent cannot list them.
 */
export const GET = withAuth<Params>(
  { name: 'GET /api/v1/orgs/{orgSlug}/agent-actions' },
  async ({ ctx }) => jsonOk({ actions: await listMyActions(ctx) }),
);
