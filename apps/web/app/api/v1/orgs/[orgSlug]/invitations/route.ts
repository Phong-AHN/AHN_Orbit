import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { createInvitationSchema } from '@/features/tenancy/contracts';
import { createInvitation, listInvitations } from '@/features/tenancy/invitations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

export const GET = withAuth<Params>(
  { permission: 'member:list', name: 'GET /api/v1/orgs/{orgSlug}/invitations' },
  async ({ ctx }) => jsonOk({ invitations: await listInvitations(ctx) }),
);

export const POST = withAuth<Params>(
  { permission: 'member:invite', name: 'POST /api/v1/orgs/{orgSlug}/invitations' },
  async ({ request, ctx }) => {
    const input = await readJsonBody(request, createInvitationSchema);
    const { token, ...invitation } = await createInvitation(
      ctx,
      input,
      requestFingerprint(request),
    );

    // The token is returned exactly once, to the inviter, so the UI can render
    // a shareable link before the email sender exists (T1.15). Only its hash is
    // stored, so this is the sole moment it is ever available.
    return jsonOk({ invitation, token }, { status: 201 });
  },
);
