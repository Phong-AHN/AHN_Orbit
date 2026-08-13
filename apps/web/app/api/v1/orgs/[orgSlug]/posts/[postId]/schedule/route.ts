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
 * `post:schedule` is checked here *and* by the state machine inside
 * `transitionPost` — the route's check keeps the failure a clean 403 before any
 * scheduling work happens, and the machine's is the one that actually decides.
 */
export const POST = withAuth<Params>(
  {
    permission: 'post:schedule',
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
