import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { listMembers } from '@/features/tenancy/members';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

export const GET = withAuth<Params>(
  { permission: 'member:list', name: 'GET /api/v1/orgs/{orgSlug}/members' },
  async ({ ctx }) => jsonOk({ members: await listMembers(ctx) }),
);
