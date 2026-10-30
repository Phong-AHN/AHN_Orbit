import { z } from 'zod';
import { NotFoundError } from '@orbit/core';
import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { confirmAction } from '@/features/agent/actions';
import { agentEnabledFor } from '@/features/agent/availability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; actionId: string };

/**
 * Confirm an agent action, which runs it — once, as summarised, with the
 * person's rights checked again now (D-109 §5).
 *
 * A person's act in their own session: `listMyActions`'s guard refuses an
 * agent, and this route is not in the agent's route table. The session cookie
 * is `SameSite=Lax`, so another site cannot make the browser post here.
 */
export const POST = withAuth<Params>(
  { name: 'POST /api/v1/orgs/{orgSlug}/agent-actions/{actionId}/confirm' },
  async ({ request, ctx, organization, params }) => {
    const actionId = z.string().uuid().parse(params.actionId);
    // The kill switch stops prepared actions too, not only new ones.
    if (!agentEnabledFor(organization)) throw new NotFoundError('Agent action');

    return jsonOk(
      await confirmAction(ctx, actionId, {
        origin: new URL(request.url).origin,
        forwardedFor: request.headers.get('x-forwarded-for'),
      }),
    );
  },
);
