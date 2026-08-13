import { jsonOk } from '@/server/api-response';
import { withPlatformAdmin } from '@/server/with-platform-admin';
import { listSocialAccountHealth } from '@/features/admin/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Connection health across every tenant (docs/API.md §2.13).
 *
 * Status, platform, when it was last checked, and which organization it belongs
 * to. **Not** the account's name, handle or external id: which Pages a client
 * manages is their commercial information, and docs/RBAC.md §3 note 2 allows a
 * platform admin the status and nothing more (**D-044**).
 *
 * No endpoint in this surface reads `SocialCredential`, at any privilege level.
 */
export const GET = withPlatformAdmin(
  { permission: 'admin:view_system_logs', name: 'GET /api/v1/admin/social-accounts' },
  async ({ request }) => {
    const status = new URL(request.url).searchParams.get('status') ?? undefined;
    return jsonOk({ accounts: await listSocialAccountHealth(status) });
  },
);
