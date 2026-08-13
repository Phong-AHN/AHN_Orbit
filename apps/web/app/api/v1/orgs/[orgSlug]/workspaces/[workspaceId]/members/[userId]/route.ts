import { NextResponse } from 'next/server';
import { withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { removeWorkspaceMember } from '@/features/tenancy/members';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; workspaceId: string; userId: string };

export const DELETE = withAuth<Params>(
  {
    permission: 'workspace:manage_members',
    resource: ({ params }) => ({ workspaceId: params.workspaceId }),
    name: 'DELETE /api/v1/orgs/{orgSlug}/workspaces/{workspaceId}/members/{userId}',
  },
  async ({ request, ctx, params }) => {
    await removeWorkspaceMember(
      ctx,
      params.workspaceId,
      params.userId,
      requestFingerprint(request),
    );
    return new NextResponse(null, { status: 204 });
  },
);
