import { jsonOk } from '@/server/api-response';
import { withPlatformAdmin } from '@/server/with-platform-admin';
import { platformHealth } from '@/features/admin/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Is the platform working? (docs/API.md §2.13)
 *
 * Aggregate only — queue depths, the age of the oldest waiting job, dead-letter
 * count, and totals that describe scale rather than any customer. docs/RBAC.md
 * §3 note 3 permits "job counts, error rates, API health" and excludes client
 * performance data, which is why there is no per-tenant figure here.
 *
 * Distinct from the unauthenticated `/api/health` liveness probe: this one is
 * for a person deciding whether to page somebody.
 */
export const GET = withPlatformAdmin(
  { permission: 'admin:view_jobs', name: 'GET /api/v1/admin/health' },
  async () => jsonOk(await platformHealth()),
);
