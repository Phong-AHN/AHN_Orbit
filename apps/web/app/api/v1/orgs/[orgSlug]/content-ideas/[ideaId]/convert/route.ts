import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { convertIdeaToPost } from '@/features/ideas/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; ideaId: string };

/**
 * Turn an idea into a draft post.
 *
 * `post:create`, because that is what it does. The post arrives as a `DRAFT`
 * and travels the ordinary state machine from there — nothing here schedules,
 * approves or publishes (SRS §25).
 *
 * Converting twice is refused rather than producing a second draft, which is
 * what a double-clicked button would otherwise do.
 */
export const POST = withAuth<Params>(
  {
    permission: 'post:create',
    name: 'POST /api/v1/orgs/{orgSlug}/content-ideas/{ideaId}/convert',
  },
  async ({ request, ctx, params }) => {
    const post = await convertIdeaToPost(ctx, params.ideaId, requestFingerprint(request));

    return jsonOk({ post }, { status: 201 });
  },
);
