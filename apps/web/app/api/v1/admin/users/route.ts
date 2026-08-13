import { jsonOk } from '@/server/api-response';
import { withPlatformAdmin } from '@/server/with-platform-admin';
import { listUsers } from '@/features/admin/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * People, for support lookups (docs/API.md §2.13).
 *
 * Returns who someone is and which organizations they belong to — never what
 * they have written, approved or published.
 */
export const GET = withPlatformAdmin(
  { permission: 'admin:view_system_logs', name: 'GET /api/v1/admin/users' },
  async ({ request }) => {
    const search = new URL(request.url).searchParams.get('q') ?? undefined;
    return jsonOk({ users: await listUsers(search) });
  },
);
