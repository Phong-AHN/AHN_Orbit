import { effectivePermissions } from '@orbit/rbac';
import { isUserPrincipal } from '@orbit/core';
import { withAuth } from '@/server/with-auth';
import { jsonOk } from '@/server/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The caller's standing inside one organization.
 *
 * This is what the frontend's `useCan()` is built from — used to *hide*
 * controls, never to decide anything. Every mutation is re-checked server-side
 * (docs/RBAC.md §6).
 */
export const GET = withAuth<{ orgSlug: string }>(
  { name: 'GET /api/v1/orgs/{orgSlug}/me' },
  async ({ ctx, organization, user }) => {
    const principal = ctx.principal;

    return jsonOk({
      organization,
      membership: isUserPrincipal(principal)
        ? {
            role: principal.organizationRole,
            status: principal.membershipStatus,
            workspaces: principal.workspaces,
            brands: principal.brands,
          }
        : null,
      permissions: effectivePermissions(ctx),
      user: { id: user.id, email: user.email, name: user.name },
    });
  },
);
