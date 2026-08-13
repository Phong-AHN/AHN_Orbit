import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { transitionSchema } from '@/features/posts/contracts';
import { assertNotSystemStatus, postScope, transitionPost } from '@/features/posts/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; postId: string };

/**
 * The only route that changes a post's status.
 *
 * No `permission` is declared here, deliberately. Which permission applies
 * depends on *which* transition was asked for — submitting for review, approving,
 * scheduling and cancelling are four different rights — so the state machine
 * names it and `assertTransitionAllowed` enforces it inside the service. Naming
 * one permission here would be wrong for most transitions and too broad for the
 * rest.
 */
export const POST = withAuth<Params>(
  { name: 'POST /api/v1/orgs/{orgSlug}/posts/{postId}/transition' },
  async ({ request, ctx, params }) => {
    const { to, comment } = await readJsonBody(request, transitionSchema);

    // Resolving the post first means another tenant's id is a 404 before any
    // status logic runs, so this route cannot be used to probe for ids.
    await postScope(ctx, params.postId);

    // Defence in depth. The machine already refuses these for a human actor;
    // this catches a future transition table that forgot to mark one SYSTEM.
    assertNotSystemStatus(to);

    return jsonOk({
      post: await transitionPost(ctx, params.postId, to, requestFingerprint(request), { comment }),
    });
  },
);
