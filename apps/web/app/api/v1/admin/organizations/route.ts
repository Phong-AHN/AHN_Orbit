import { jsonOk } from '@/server/api-response';
import { withPlatformAdmin } from '@/server/with-platform-admin';
import { listOrganizations } from '@/features/admin/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Tenants, as operational records (docs/API.md §2.13).
 *
 * `admin:view_system_logs` is the "see system state" permission — docs/RBAC.md
 * §2 defines a platform administrator as AHN staff who "sees system state, never
 * client content or secrets", and an organization's name, plan and counts are
 * exactly that (**D-043**).
 */
export const GET = withPlatformAdmin(
  { permission: 'admin:view_system_logs', name: 'GET /api/v1/admin/organizations' },
  async ({ request }) => {
    const search = new URL(request.url).searchParams.get('q') ?? undefined;
    return jsonOk({ organizations: await listOrganizations(search) });
  },
);
