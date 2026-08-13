import type { NextRequest } from 'next/server';
import { NotFoundError, isUserPrincipal, newCorrelationId, type TenantContext } from '@orbit/core';
import {
  SESSION_COOKIE_NAME,
  requireSession,
  resolveTenantContext,
  resolveUser,
  type AuthenticatedUser,
} from '@orbit/auth';
import { platformDb } from '@orbit/db';
import { assertCan, type Permission, type ResourceScope } from '@orbit/rbac';
import { logger, withLogContext } from '@orbit/observability';
import { handleRouteError } from './api-response';

/**
 * The client portal's entry point (SRS §21, decision D-012).
 *
 * A **separate wrapper**, not `withAuth` with a flag, because the portal is a
 * separate surface with different rules — and the difference is precisely the
 * kind that a shared wrapper with a boolean would eventually get wrong.
 *
 * Three things differ from the agency wrapper:
 *
 *  1. **The tenant is not in the URL.** A portal URL names a workspace or a
 *     post, never an organization: the agency's slug is the agency's business,
 *     and putting it in a client's address bar hands them a fact about the
 *     agency they had no reason to learn. The organization is derived from the
 *     **subject row**, then cross-checked against membership — the same
 *     structure `resolveTenantContext` uses for an org ref, and the same one
 *     decision D-021 requires of the worker.
 *  2. **Only a Client may be here.** docs/RBAC.md §1 rule 3 confines a Client to
 *     the portal; this is the other half of that sentence. The narrowed portal
 *     projections are calibrated to a Client, and letting other roles through
 *     would mean every leakage test had to be repeated per role for no product
 *     gain (decision D-038).
 *  3. **Workspace membership is required, always.** An organization membership
 *     is not enough: a Client reaches exactly the workspaces they hold a
 *     `WorkspaceMembership` in, and every other workspace — including one in
 *     the same organization — is a 404.
 *
 * Everything that is *not* different is deliberately identical: authentication,
 * the RBAC engine, the tenant-scoped client, the error envelope. The portal is
 * a narrower surface, not a looser one.
 */

export interface PortalInput<P> {
  request: NextRequest;
  params: P;
  ctx: TenantContext;
  user: AuthenticatedUser;
  /** The workspace this request resolved to. Always one the client belongs to. */
  workspaceId: string;
}

type ParamsPromise<P> = { params: Promise<P> };

export interface PortalRouteOptions<P> {
  permission?: Permission;
  /**
   * Locate the workspace this request is about.
   *
   * Returns either a workspace id straight from the path, or a subject whose row
   * carries one. Nothing else is accepted — a request that cannot name its
   * workspace cannot be authorized, and defaulting to "all of them" is exactly
   * the bug this shape exists to prevent.
   */
  subject: (input: { params: P; request: NextRequest }) => PortalSubject;
  resource?: (input: {
    params: P;
    ctx: TenantContext;
    workspaceId: string;
  }) => Promise<ResourceScope> | ResourceScope;
  name?: string;
}

export type PortalSubject =
  { kind: 'workspace'; workspaceId: string } | { kind: 'post'; postId: string };

/**
 * Resolve the organization and workspace a portal request belongs to.
 *
 * The one unscoped read the portal makes, and it selects nothing but the
 * identifiers needed to *build* a scope — never to bypass one. Everything the
 * handler then does goes through the tenant-scoped client.
 */
async function locate(
  subject: PortalSubject,
): Promise<{ organizationId: string; workspaceId: string } | null> {
  if (subject.kind === 'workspace') {
    const workspace = await platformDb.workspace.findFirst({
      where: { id: subject.workspaceId, deletedAt: null },
      select: { id: true, organizationId: true },
    });
    return workspace
      ? { organizationId: workspace.organizationId, workspaceId: workspace.id }
      : null;
  }

  const post = await platformDb.post.findFirst({
    where: { id: subject.postId, deletedAt: null },
    select: { organizationId: true, workspaceId: true },
  });
  return post ? { organizationId: post.organizationId, workspaceId: post.workspaceId } : null;
}

export function withPortalAuth<P extends Record<string, string>>(
  options: PortalRouteOptions<P>,
  handler: (input: PortalInput<P>) => Promise<Response>,
): (request: NextRequest, routeContext: ParamsPromise<P>) => Promise<Response> {
  return async (request, routeContext) => {
    const correlationId = request.headers.get('x-correlation-id') ?? newCorrelationId();
    const route = options.name ?? new URL(request.url).pathname;

    return withLogContext({ correlationId, route, surface: 'portal' }, async () => {
      try {
        // ── 1. AUTHENTICATE ────────────────────────────────────────────────
        const identity = await requireSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);

        // ── 2. RESOLVE USER ────────────────────────────────────────────────
        const user = await resolveUser(identity);

        // ── 3. LOCATE THE SUBJECT, AND TAKE THE TENANT FROM IT ─────────────
        const params = await routeContext.params;
        const located = await locate(options.subject({ params, request }));

        // Indistinguishable from "you may not see it" — deliberately. A caller
        // must not be able to tell a non-existent workspace from someone
        // else's (docs/API.md §1).
        if (!located) throw new NotFoundError('Not found');

        const { ctx } = await resolveTenantContext(user, located.organizationId, correlationId);

        return await withLogContext(
          { organizationId: ctx.organizationId, userId: user.id },
          async () => {
            // ── 4. CONFINE TO THE PORTAL ───────────────────────────────────
            assertPortalPrincipal(ctx, route);

            // ── 5. CONFINE TO THEIR OWN WORKSPACES ─────────────────────────
            assertWorkspaceMember(ctx, located.workspaceId, route);

            // ── 6. AUTHORIZE ───────────────────────────────────────────────
            if (options.permission) {
              const scope = options.resource
                ? await options.resource({ params, ctx, workspaceId: located.workspaceId })
                : { workspaceId: located.workspaceId };
              assertCan(ctx, options.permission, scope);
            }

            // ── 7. HANDLER (portal projections only) ───────────────────────
            return await handler({
              request,
              params,
              ctx,
              user,
              workspaceId: located.workspaceId,
            });
          },
        );
      } catch (error) {
        return handleRouteError(error, route);
      }
    });
  };
}

/**
 * The portal is for clients.
 *
 * A 404 rather than a 403: an internal user probing portal URLs learns nothing
 * about whether they exist, and a Client is never in a position to hit this
 * branch at all.
 */
function assertPortalPrincipal(ctx: TenantContext, route: string): void {
  if (!isUserPrincipal(ctx.principal) || ctx.principal.organizationRole !== 'CLIENT') {
    logger.warn('non-client principal reached a portal route', {
      route,
      organizationId: ctx.organizationId,
      role: isUserPrincipal(ctx.principal) ? ctx.principal.organizationRole : 'SYSTEM',
    });
    throw new NotFoundError('Not found');
  }
}

/**
 * A Client reaches exactly the workspaces they hold a membership in.
 *
 * Note what this does *not* do: fall back to the organization. `OWNER` and
 * `ADMIN` are org-wide by definition (docs/RBAC.md §1 rule 1) and a Client is
 * emphatically not, so a workspace in the same organization that they have no
 * membership in is as invisible as one in another tenant — a 404 either way.
 */
function assertWorkspaceMember(ctx: TenantContext, workspaceId: string, route: string): void {
  if (!isUserPrincipal(ctx.principal)) throw new NotFoundError('Not found');

  const member = ctx.principal.workspaces.some((w) => w.workspaceId === workspaceId);
  if (member) return;

  logger.warn('client requested a workspace they do not belong to', {
    securityEvent: true,
    route,
    organizationId: ctx.organizationId,
    userId: ctx.principal.userId,
    workspaceId,
  });

  throw new NotFoundError('Not found');
}
