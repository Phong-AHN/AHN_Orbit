import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { listThreads } from '@/features/copilot/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/** The signed-in person's own Copilot threads (D-109). Nobody else's. */
export const GET = withAuth<Params>(
  { name: 'GET /api/v1/orgs/{orgSlug}/copilot/threads' },
  async ({ ctx }) => jsonOk({ threads: await listThreads(ctx) }),
);
