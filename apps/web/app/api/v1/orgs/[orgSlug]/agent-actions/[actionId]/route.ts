import { z } from 'zod';
import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { getActionStatus } from '@/features/agent/actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; actionId: string };

/**
 * One agent action's state. Readable by the person and by the agent acting for
 * them — so it can say whether what it prepared went through — and only for
 * that person's own actions.
 */
export const GET = withAuth<Params>(
  { name: 'GET /api/v1/orgs/{orgSlug}/agent-actions/{actionId}' },
  async ({ ctx, params }) =>
    jsonOk({ action: await getActionStatus(ctx, z.string().uuid().parse(params.actionId)) }),
);
