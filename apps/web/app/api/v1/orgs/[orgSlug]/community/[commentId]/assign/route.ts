import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { assignSchema } from '@/features/community/contracts';
import { commentResourceScope } from '@/features/community/route-scope';
import { assignComment } from '@/features/community/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; commentId: string };

/**
 * Hand a comment to a teammate (docs/API.md §2.15).
 *
 * `assignedToId` is nullable, which is how somebody hands it back rather than
 * reassigning it to themselves to clear it.
 *
 * The assignee is validated in the service against live memberships, not
 * trusted from the body: `User` spans organizations and is the one reference in
 * the schema that cannot be made composite, so a foreign key alone would
 * cheerfully accept somebody from another tenant.
 */
export const POST = withAuth<Params>(
  {
    permission: 'comment:reply',
    resource: commentResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/community/{commentId}/assign',
  },
  async ({ request, ctx, params }) => {
    const input = assignSchema.parse(await request.json());

    return jsonOk({
      comment: await assignComment(ctx, params.commentId, input, requestFingerprint(request)),
    });
  },
);
