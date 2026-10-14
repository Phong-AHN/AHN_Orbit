import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { isAppError, isUserPrincipal, newCorrelationId, type TenantContext } from '@orbit/core';
import {
  SESSION_COOKIE_NAME,
  requireSession,
  resolveTenantContext,
  resolveUser,
  type AuthenticatedUser,
  type OrganizationSummary,
} from '@orbit/auth';
import { can, canSomewhere, type Permission, type ResourceScope } from '@orbit/rbac';
import { logger } from '@orbit/observability';
import { homeForUser } from './home';

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
 *
 * **Clients are sent to their portal**, which is the page-level counterpart of
 * `assertNotClient` in `with-auth.ts`. Until this existed the two layers
 * disagreed: the agency *API* refused a `CLIENT` principal on every route, and
 * the agency *pages* did not — so a client who reached `/orgs/{slug}/dashboard`
 * got a rendered agency shell whose every call then 404'd. `portal-context.ts`
 * states the rule this restores: a page must not be able to reach data by a
 * looser path than an endpoint would.
 *
 * A redirect rather than the API's `notFound()`, because the two are protecting
 * different things. The API answers 404 to keep the agency API's *shape*
 * unknowable to a client. A page has no shape to hide from somebody who is
 * already a member of this organization and knows it — so the useful answer is
 * to put them where they belong.
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

  let resolved: { ctx: TenantContext; organization: OrganizationSummary };
  try {
    resolved = await resolveTenantContext(user, organizationRef, correlationId);
  } catch (error) {
    // `resolveTenantContext` answers 404 for both "no such organization" and
    // "not a member" on purpose; either way there is nothing to show here.
    if (isAppError(error) && (error.status === 404 || error.status === 403)) {
      redirect('/orgs');
    }
    throw error;
  }

  // Outside the `try` deliberately. `redirect()` signals by throwing, so a
  // redirect from inside that block would land in a `catch` written for tenant
  // resolution failures — it happens to survive the `throw error` at the end of
  // it, which is luck rather than design, and the next person to add a branch
  // there would silently swallow it.
  const { ctx, organization } = resolved;

  if (isUserPrincipal(ctx.principal) && ctx.principal.organizationRole === 'CLIENT') {
    logger.warn('client principal redirected off an agency page', {
      securityEvent: true,
      organizationId: ctx.organizationId,
      userId: ctx.principal.userId,
    });

    // Resolved rather than assumed: a client may hold several workspaces, and
    // one with none at all has nowhere to go — `/continue` says so instead of
    // bouncing between surfaces.
    const home = await homeForUser(user, 'portal');
    redirect(home.path ?? '/continue');
  }

  return { ctx, organization, user };
}

/** Non-throwing permission check for deciding what a page renders. */
/**
 * "Is this part of their product at all?" — for navigation only.
 *
 * See `canSomewhere` in @orbit/rbac: a workspace-scoped grant asked without a
 * workspace correctly denies, so building a menu with `pageCan` would hide
 * Analytics, Media and Approvals from an Account Manager. This guards nothing;
 * the page and the API each check properly with the real resource.
 */
export function pageCanSomewhere(ctx: TenantContext, permission: Permission): boolean {
  return canSomewhere(ctx, permission);
}

export function pageCan(
  ctx: TenantContext,
  permission: Permission,
  resource: ResourceScope = {},
): boolean {
  return can(ctx, permission, resource);
}
