import type { NextRequest } from 'next/server';
import { NotFoundError, newCorrelationId } from '@orbit/core';
import {
  SESSION_COOKIE_NAME,
  requireSession,
  resolveUser,
  type AuthenticatedUser,
} from '@orbit/auth';
import { canPlatform, type Permission } from '@orbit/rbac';
import { logger, withLogContext } from '@orbit/observability';
import { handleRouteError } from './api-response';

/**
 * The platform admin surface (SRS §28, docs/RBAC.md §1 rule 4).
 *
 * A **third** wrapper, alongside `withAuth` (agency) and `withPortalAuth`
 * (client), because platform administration is a third thing: it has no tenant
 * at all. An admin route is not "an agency route with extra rights" — it
 * operates the SaaS rather than acting inside an organization, and the whole
 * point of rule 4 is that those are different.
 *
 * What that means concretely, and what this wrapper enforces:
 *
 *  1. **No `TenantContext` is ever produced.** A handler behind this wrapper
 *     receives a user and nothing else, so it *cannot* call `withTenant` —
 *     the scoped client is only constructible from a tenant context, and no
 *     tenant context exists here. Reading client content is not forbidden by
 *     convention; it is unreachable.
 *  2. **`isPlatformAdmin` comes from Postgres, never a token claim.**
 *     `resolveUser` reads the `User` row, which is what docs/RBAC.md §1 rule 2
 *     requires — the Firebase custom claim is a fast path, never the authority.
 *  3. **404 for everyone else.** Not 403: the existence and shape of the admin
 *     API is not something a tenant user gets to discover (docs/API.md §1).
 *
 * Actions that *do* touch tenant data — there is one, retrying a dead-lettered
 * job — go through `platformAudit`, which requires a reason and writes into the
 * affected organization's own audit log.
 */

export interface PlatformAdminInput<P> {
  request: NextRequest;
  params: P;
  /** The administrator. Deliberately the only identity a handler receives. */
  admin: AuthenticatedUser;
}

type ParamsPromise<P> = { params: Promise<P> };

export interface PlatformRouteOptions {
  /**
   * The platform permission this route needs.
   *
   * Required rather than optional: an admin route with no stated permission is
   * one whose authorization nobody wrote down.
   */
  permission: Permission;
  name?: string;
}

export function withPlatformAdmin<P extends Record<string, string> = Record<string, never>>(
  options: PlatformRouteOptions,
  handler: (input: PlatformAdminInput<P>) => Promise<Response>,
): (request: NextRequest, routeContext?: ParamsPromise<P>) => Promise<Response> {
  return async (request, routeContext) => {
    const correlationId = request.headers.get('x-correlation-id') ?? newCorrelationId();
    const route = options.name ?? new URL(request.url).pathname;

    return withLogContext({ correlationId, route, surface: 'admin' }, async () => {
      try {
        // ── 1. AUTHENTICATE ────────────────────────────────────────────────
        const identity = await requireSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);

        // ── 2. RESOLVE USER — and with it the authoritative platform flag ──
        const admin = await resolveUser(identity);

        // ── 3. AUTHORIZE against the platform grant list ───────────────────
        if (!canPlatform(admin, options.permission)) {
          logger.warn('non-admin principal reached a platform admin route', {
            securityEvent: true,
            route,
            userId: admin.id,
            permission: options.permission,
          });
          throw new NotFoundError('Not found');
        }

        const params = ((await routeContext?.params) ?? {}) as P;

        // Every admin request is logged with its actor, whether or not it
        // changes anything. Reads of system state are part of the operational
        // record (SRS §28).
        logger.info('platform admin request', {
          route,
          userId: admin.id,
          permission: options.permission,
        });

        // ── 4. HANDLER — no tenant context, by construction ────────────────
        return await handler({ request, params, admin });
      } catch (error) {
        return handleRouteError(error, route);
      }
    });
  };
}
