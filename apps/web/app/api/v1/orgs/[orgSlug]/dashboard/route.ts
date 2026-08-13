import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { dashboardSummary } from '@/features/dashboard/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * The agency dashboard (docs/API.md §2.1, SRS §20).
 *
 * Gated on `org:read` rather than `post:read`, and deliberately so. The
 * dashboard is an organization-level overview, and `org:read` is the one
 * permission every internal role holds **org-wide** — a workspace-scoped
 * `post:read` would deny a Content Creator here for want of a `workspaceId`
 * that an overview has no business requiring. `CLIENT` holds no `org:read` at
 * all, which makes this doubly closed to them alongside the portal boundary
 * (**D-038**).
 *
 * The permission opens the page; it does not decide the contents. Every figure
 * is narrowed to `accessibleWorkspaceIds`, and the account-health section is
 * additionally gated on `social_account:read` inside the service.
 */
export const GET = withAuth<Params>(
  { permission: 'org:read', name: 'GET /api/v1/orgs/{orgSlug}/dashboard' },
  async ({ ctx }) => jsonOk(await dashboardSummary(ctx)),
);
