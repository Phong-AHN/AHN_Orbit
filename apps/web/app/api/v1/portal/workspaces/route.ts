import type { NextRequest } from 'next/server';
import { isUserPrincipal, newCorrelationId } from '@orbit/core';
import {
  SESSION_COOKIE_NAME,
  listAccessibleOrganizations,
  requireSession,
  resolveTenantContext,
  resolveUser,
} from '@orbit/auth';
import { withLogContext } from '@orbit/observability';
import { handleRouteError, jsonOk } from '@/server/api-response';
import { listPortalWorkspaces } from '@/features/portal/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The client's own front door (docs/API.md §2.12).
 *
 * The one portal route that cannot use `withPortalAuth`, because it is the route
 * that *discovers* which workspaces exist for this person — there is no subject
 * to derive a tenant from yet. It therefore does the resolution itself, in the
 * same order, and is the only place in the portal that looks across
 * organizations at all.
 *
 * A client of two different agencies gets both of their workspaces here, with no
 * indication that the agencies are separate tenants: the response names
 * workspaces, never organizations.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = newCorrelationId();
  const route = 'GET /api/v1/portal/workspaces';

  return withLogContext({ correlationId, route, surface: 'portal' }, async () => {
    try {
      const identity = await requireSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
      const user = await resolveUser(identity);

      const organizations = await listAccessibleOrganizations(user.id);

      const workspaces = [];

      for (const organization of organizations) {
        const { ctx } = await resolveTenantContext(user, organization.id, correlationId);

        // Only where this person is a Client. An internal user has no portal,
        // and an organization where they are staff contributes nothing here.
        if (!isUserPrincipal(ctx.principal) || ctx.principal.organizationRole !== 'CLIENT') {
          continue;
        }

        const memberships = ctx.principal.workspaces.map((w) => w.workspaceId);
        workspaces.push(...(await listPortalWorkspaces(ctx, memberships)));
      }

      return jsonOk({ workspaces });
    } catch (error) {
      return handleRouteError(error, route);
    }
  });
}
