import { z } from 'zod';
import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { commentResourceScope } from '@/features/community/route-scope';
import { setHandled } from '@/features/community/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; commentId: string };

const bodySchema = z.object({ handled: z.boolean() });

/**
 * Mark a comment dealt with, or put it back in the queue.
 *
 * Takes `handled` as a boolean rather than having a second route to reopen:
 * both directions are the same decision by the same person about the same row,
 * and a `DELETE /handled` would read as deleting the comment.
 *
 * Guarded by `comment:reply` rather than a permission of its own. Marking a
 * comment handled is *acting on* it — it takes the comment out of everyone
 * else's queue — and an agency does not distinguish the person who may answer
 * from the person who may decide no answer is needed.
 */
export const POST = withAuth<Params>(
  {
    permission: 'comment:reply',
    resource: commentResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/community/{commentId}/handled',
  },
  async ({ request, ctx, params }) => {
    const { handled } = bodySchema.parse(await request.json());

    return jsonOk({
      comment: await setHandled(ctx, params.commentId, handled, requestFingerprint(request)),
    });
  },
);
