import { z } from 'zod';
import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { rejectAction } from '@/features/agent/actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; actionId: string };

/** Reject an agent action. It never runs (D-109 §5). A person's act; an agent is refused. */
export const POST = withAuth<Params>(
  { name: 'POST /api/v1/orgs/{orgSlug}/agent-actions/{actionId}/reject' },
  async ({ ctx, params }) => {
    await rejectAction(ctx, z.string().uuid().parse(params.actionId));
    return jsonOk({ status: 'REJECTED' });
  },
);
