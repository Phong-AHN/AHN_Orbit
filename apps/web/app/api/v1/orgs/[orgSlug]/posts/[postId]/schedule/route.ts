import { NextResponse } from 'next/server';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { PROTECTED_POST_FIELDS } from '@/features/posts/contracts';
import { postResourceScope } from '@/features/posts/route-scope';
import { scheduleSchema } from '@/features/scheduling/contracts';
import { reschedulePost, schedulePost, unschedulePost } from '@/features/scheduling/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; postId: string };

/**
 * Schedule an approved post.
 *
 * No `permission` is declared here, for the reason `DELETE` below declares none:
 * the state machine names the right that applies and enforces it inside
 * `transitionPost`.
 *
 * This route used to also check `post:schedule` itself, as a cheaper early 403.
 * That stopped being equivalent with **D-106**: an author may schedule their own
 * post in a workspace with no client, and only the machine knows the workspace
 * and the author — so the route's coarse check refused the very person the
 * rule exists for, before the rule was ever reached. Nothing is weakened by
 * removing it: `schedulePost` writes only inside the transition's transaction,
 * after the machine has authorised it, and an unauthorised caller still gets a
 * 403 from the same check, a moment later.
 */
export const POST = withAuth<Params>(
  {
    resource: postResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/posts/{postId}/schedule',
  },
  async ({ request, ctx, params }) => {
    const input = await readJsonBody(request, scheduleSchema, {
      alsoForbid: PROTECTED_POST_FIELDS,
    });

    return jsonOk(await schedulePost(ctx, params.postId, input, requestFingerprint(request)));
  },
);

/**
 * Move an already-scheduled post — the drag-and-drop path.
 *
 * A separate verb because it is a separate right: `post:reschedule` is held by
 * roles that may shuffle the calendar without being able to put new things on
 * it. The service re-checks it, since this route's `resource` scope is resolved
 * before the status is known to still be SCHEDULED.
 */
export const PATCH = withAuth<Params>(
  {
    permission: 'post:reschedule',
    resource: postResourceScope,
    name: 'PATCH /api/v1/orgs/{orgSlug}/posts/{postId}/schedule',
  },
  async ({ request, ctx, params }) => {
    const input = await readJsonBody(request, scheduleSchema, {
      alsoForbid: PROTECTED_POST_FIELDS,
    });

    return jsonOk(await reschedulePost(ctx, params.postId, input, requestFingerprint(request)));
  },
);

/**
 * Take a post off the schedule.
 *
 * Returns it to DRAFT through the state machine, which voids approvals —
 * reopening approved content is exactly what this is. Cancelling outright is a
 * different act with a different right; that is `/transition` to CANCELED.
 *
 * No permission is declared: the machine names the one that applies to
 * `SCHEDULED → DRAFT` (`post:update`) and enforces it.
 */
export const DELETE = withAuth<Params>(
  { name: 'DELETE /api/v1/orgs/{orgSlug}/posts/{postId}/schedule' },
  async ({ request, ctx, params }) => {
    await unschedulePost(ctx, params.postId, requestFingerprint(request));
    return new NextResponse(null, { status: 204 });
  },
);
