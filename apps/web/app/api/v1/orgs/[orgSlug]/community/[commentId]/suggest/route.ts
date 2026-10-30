import { z } from 'zod';
import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { commentResourceScope } from '@/features/community/route-scope';
import { suggestCommentReply } from '@/features/assistant/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Params = { orgSlug: string; commentId: string };

/**
 * Draft a public reply to a comment from the brand's documents (D-109 §8.5).
 * Nothing is sent: replying is a separate, deliberate act.
 */
export const POST = withAuth<Params>(
  {
    permission: 'comment:reply',
    resource: commentResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/community/{commentId}/suggest',
  },
  async ({ ctx, params }) =>
    jsonOk({
      suggestion: await suggestCommentReply(ctx, z.string().uuid().parse(params.commentId)),
    }),
);
