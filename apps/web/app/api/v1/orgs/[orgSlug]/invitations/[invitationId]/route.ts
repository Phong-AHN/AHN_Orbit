import { NextResponse } from 'next/server';
import { withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { revokeInvitation } from '@/features/tenancy/invitations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; invitationId: string };

/**
 * Withdraw an invitation that has not been accepted.
 *
 * `member:invite` rather than `member:remove`: withdrawing an offer is the
 * other half of making one, and somebody who can invite a client into their own
 * workspace must be able to take it back — without that also granting them the
 * right to remove people who already joined.
 *
 * The row is marked revoked rather than deleted, so the audit trail keeps the
 * fact that an invitation was made and withdrawn.
 */
export const DELETE = withAuth<Params>(
  {
    permission: 'member:invite',
    name: 'DELETE /api/v1/orgs/{orgSlug}/invitations/{invitationId}',
  },
  async ({ request, ctx, params }) => {
    await revokeInvitation(ctx, params.invitationId, requestFingerprint(request));
    return new NextResponse(null, { status: 204 });
  },
);
