import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { updateIdeaSchema } from '@/features/ideas/contracts';
import { getIdea, updateIdea } from '@/features/ideas/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; ideaId: string };

export const GET = withAuth<Params>(
  { permission: 'post:read', name: 'GET /api/v1/orgs/{orgSlug}/content-ideas/{ideaId}' },
  async ({ ctx, params }) => jsonOk({ idea: await getIdea(ctx, params.ideaId) }),
);

/**
 * Edit an idea, or accept/dismiss it.
 *
 * `CONVERTED` is not settable here — an idea becomes converted by being
 * converted, and a client that could claim the state could claim a post exists
 * that does not.
 */
export const PATCH = withAuth<Params>(
  { permission: 'post:update', name: 'PATCH /api/v1/orgs/{orgSlug}/content-ideas/{ideaId}' },
  async ({ request, ctx, params }) => {
    const input = await readJsonBody(request, updateIdeaSchema);

    return jsonOk({
      idea: await updateIdea(ctx, params.ideaId, input, requestFingerprint(request)),
    });
  },
);
