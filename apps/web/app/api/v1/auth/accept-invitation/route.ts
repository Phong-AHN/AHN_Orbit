import { newCorrelationId } from '@orbit/core';
import { currentCorrelationId } from '@orbit/observability';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withUser } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { acceptInvitationSchema } from '@/features/tenancy/contracts';
import { acceptInvitation } from '@/features/tenancy/invitations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Redeem an invitation.
 *
 * Authenticated but not tenant-scoped: the caller has no membership yet, which
 * is the whole point. The token authorises joining; the session decides *who*
 * joins, and the invited address must match it — so a forwarded link is
 * useless to anyone else.
 */
export const POST = withUser(
  { name: 'POST /api/v1/auth/accept-invitation' },
  async ({ request, user }) => {
    const { token } = await readJsonBody(request, acceptInvitationSchema);

    const result = await acceptInvitation(
      { id: user.id, email: user.email },
      token,
      currentCorrelationId() ?? newCorrelationId(),
      requestFingerprint(request),
    );

    return jsonOk(result);
  },
);
