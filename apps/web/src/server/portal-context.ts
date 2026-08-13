import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { isUserPrincipal, newCorrelationId, type TenantContext } from '@orbit/core';
import {
  SESSION_COOKIE_NAME,
  listAccessibleOrganizations,
  requireSession,
  resolveTenantContext,
  resolveUser,
  type AuthenticatedUser,
} from '@orbit/auth';
import { platformDb } from '@orbit/db';

/**
 * The server-component counterpart to `withPortalAuth` (SRS §21, D-012).
 *
 * Runs the same steps in the same order as the route wrapper — authenticate,
 * derive the tenant from the workspace, confine to a Client, confine to their
 * own workspaces — because a page must not be able to reach data by a looser
 * path than an endpoint would. The only difference is the failure mode: a page
 * redirects or renders `not-found`, where an API returns a status.
 *
 * Notably it does **not** fall back to "any workspace in the organization". A
 * Client is scoped by `WorkspaceMembership` and nothing else.
 */

export interface PortalPageContext {
  ctx: TenantContext;
  user: AuthenticatedUser;
  workspace: { id: string; name: string; timezone: string };
}

async function requireClientUser(): Promise<AuthenticatedUser> {
  const cookieStore = await cookies();

  try {
    const identity = await requireSession(cookieStore.get(SESSION_COOKIE_NAME)?.value);
    return await resolveUser(identity);
  } catch {
    redirect('/sign-in?next=/portal');
  }
}

/**
 * Resolve one workspace the signed-in client may see.
 *
 * `notFound()` for everything that is not theirs — a workspace in another
 * tenant, a workspace in the same tenant they have no membership in, and a
 * workspace they are staff rather than a client of all render identically.
 */
export async function requirePortalContext(workspaceId: string): Promise<PortalPageContext> {
  const user = await requireClientUser();

  const workspace = await platformDb.workspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    select: { id: true, name: true, timezone: true, organizationId: true },
  });

  if (!workspace) notFound();

  let ctx: TenantContext;
  try {
    ({ ctx } = await resolveTenantContext(user, workspace.organizationId, newCorrelationId()));
  } catch {
    notFound();
  }

  if (!isUserPrincipal(ctx.principal) || ctx.principal.organizationRole !== 'CLIENT') {
    notFound();
  }

  if (!ctx.principal.workspaces.some((w) => w.workspaceId === workspace.id)) {
    notFound();
  }

  return {
    ctx,
    user,
    workspace: { id: workspace.id, name: workspace.name, timezone: workspace.timezone },
  };
}

/** Every workspace this client can reach, for the picker and the shell. */
export async function listPortalMemberships(): Promise<
  Array<{ id: string; name: string; timezone: string }>
> {
  const user = await requireClientUser();
  const organizations = await listAccessibleOrganizations(user.id);
  const workspaces: Array<{ id: string; name: string; timezone: string }> = [];

  for (const organization of organizations) {
    const { ctx } = await resolveTenantContext(user, organization.id);

    if (!isUserPrincipal(ctx.principal) || ctx.principal.organizationRole !== 'CLIENT') continue;

    const ids = ctx.principal.workspaces.map((w) => w.workspaceId);
    if (ids.length === 0) continue;

    const rows = await platformDb.workspace.findMany({
      where: { id: { in: ids }, organizationId: organization.id, deletedAt: null },
      select: { id: true, name: true, timezone: true },
      orderBy: { name: 'asc' },
    });

    workspaces.push(...rows);
  }

  return workspaces;
}
