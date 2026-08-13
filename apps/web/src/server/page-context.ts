import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { isAppError, newCorrelationId, type TenantContext } from '@orbit/core';
import {
  SESSION_COOKIE_NAME,
  requireSession,
  resolveTenantContext,
  resolveUser,
  type AuthenticatedUser,
  type OrganizationSummary,
} from '@orbit/auth';
import { can, type Permission, type ResourceScope } from '@orbit/rbac';

/**
 * The server-component counterpart to `withAuth`.
 *
 * It runs the same first three steps in the same order — authenticate, resolve
 * the user, resolve the tenant from the URL — so a page cannot reach data by a
 * looser path than a route handler would. What differs is the failure mode: a
 * page redirects to sign-in where an API returns 401, and an unreadable page
 * renders a permission state rather than throwing.
 *
 * Authorization itself is *not* done here. Pages ask `pageCan()` to decide what
 * to render; the API routes behind every mutation re-check independently. A
 * hidden button is a courtesy, never a control (docs/RBAC.md §6).
 */

export interface PageContext {
  ctx: TenantContext;
  organization: OrganizationSummary;
  user: AuthenticatedUser;
}

/**
 * Resolve the signed-in user and the organization named in the URL.
 *
 * Redirects to sign-in when there is no usable session, and to the organization
 * picker when the URL names an organization this user is not a member of —
 * which is the same answer they would get for one that does not exist, so page
 * navigation cannot be used to enumerate tenants either.
 */
export async function requirePageContext(organizationRef: string): Promise<PageContext> {
  const cookieStore = await cookies();
  const correlationId = newCorrelationId();

  let user: AuthenticatedUser;
  try {
    const identity = await requireSession(cookieStore.get(SESSION_COOKIE_NAME)?.value);
    user = await resolveUser(identity);
  } catch {
    redirect(`/sign-in?next=${encodeURIComponent(`/orgs/${organizationRef}`)}`);
  }

  try {
    const { ctx, organization } = await resolveTenantContext(user, organizationRef, correlationId);
    return { ctx, organization, user };
  } catch (error) {
    // `resolveTenantContext` answers 404 for both "no such organization" and
    // "not a member" on purpose; either way there is nothing to show here.
    if (isAppError(error) && (error.status === 404 || error.status === 403)) {
      redirect('/orgs');
    }
    throw error;
  }
}

/** Non-throwing permission check for deciding what a page renders. */
export function pageCan(
  ctx: TenantContext,
  permission: Permission,
  resource: ResourceScope = {},
): boolean {
  return can(ctx, permission, resource);
}
