import type { NextRequest } from 'next/server';
import {
  NotFoundError,
  ValidationError,
  isUserPrincipal,
  newCorrelationId,
  type TenantContext,
  type PostStatus,
} from '@orbit/core';
import {
  SESSION_COOKIE_NAME,
  requireSession,
  resolveTenantContext,
  resolveUser,
  type AuthenticatedUser,
  type OrganizationSummary,
} from '@orbit/auth';
import { assertCan, type Permission, type ResourceScope } from '@orbit/rbac';
import { logger, withLogContext } from '@orbit/observability';
import { handleRouteError } from './api-response';

/**
 * The single authenticated entry point for route handlers and server actions.
 *
 * It enforces this order, and nothing can reorder it:
 *
 *   1. AUTHENTICATE  session cookie → VerifiedIdentity  (never a body field)
 *   2. RESOLVE USER  firebaseUid → User row             (our id, not theirs)
 *   3. RESOLVE TENANT org ref from the PATH, cross-checked against
 *                     OrganizationMembership            (a claim, not a fact)
 *   4. AUTHORIZE     @orbit/rbac against the resolved principal
 *   5. HANDLER       receives a TenantContext, the only key to the database
 *
 * A handler cannot skip a step because it never receives anything usable until
 * every step has run: the `TenantContext` it is handed is the sole thing
 * `withTenant()` accepts.
 */

export interface AuthedInput<P> {
  request: NextRequest;
  params: P;
  /** Present whenever the route is tenant-scoped. */
  ctx: TenantContext;
  organization: OrganizationSummary;
  user: AuthenticatedUser;
}

export interface UnscopedInput<P> {
  request: NextRequest;
  params: P;
  user: AuthenticatedUser;
}

type ParamsPromise<P> = { params: Promise<P> };

export interface TenantRouteOptions<P> {
  /** Permission required before the handler runs. Omit only for read-your-own. */
  permission?: Permission;
  /**
   * Narrow the authorization check to a specific resource. Runs *after* the
   * tenant is resolved, so any lookup it performs is already confined to the
   * organization — it can only ever narrow further, never widen.
   */
  resource?: (input: {
    request: NextRequest;
    params: P;
    ctx: TenantContext;
  }) => Promise<ResourceScope> | ResourceScope;
  /** Route name for logs. Defaults to the request pathname. */
  name?: string;
}

/** Name of the path segment carrying the organization id or slug. */
const ORG_PARAM = 'orgSlug';

/**
 * Refuse a Client on an agency route (SRS §21, docs/RBAC.md §1 rule 3).
 *
 * Rule 3 says a Client "can only reach the `(portal)` routes". Until T1.16 only
 * half of that was enforced: a Client holding `post:read` reached the agency
 * post list. The list narrowed the *statuses* correctly, so nothing they were
 * forbidden to know about appeared — but the response was still shaped for the
 * agency, carrying `createdById`, `assignedToId`, `approvalRequired` and
 * per-account publishing state. That is agency-internal information about
 * content the client is otherwise entitled to see, which is exactly the
 * distinction decision D-012 exists to keep.
 *
 * Enforced here, once, rather than grant by grant: a per-endpoint check is a
 * check somebody eventually forgets to add to a new endpoint.
 *
 * A **404, not a 403** — the agency API's shape stays unknowable to a client
 * (docs/API.md §1).
 */
function assertNotClient(ctx: TenantContext, route: string): void {
  if (!isUserPrincipal(ctx.principal)) return;
  if (ctx.principal.organizationRole !== 'CLIENT') return;

  logger.warn('client principal refused on an agency route', {
    securityEvent: true,
    route,
    organizationId: ctx.organizationId,
    userId: ctx.principal.userId,
  });

  throw new NotFoundError('Not found');
}

/**
 * Wrap a tenant-scoped route handler.
 *
 * The organization is taken from `params.orgSlug` — i.e. from the URL. It is
 * never read from the body, a header, or a query parameter, and a body that
 * carries `organizationId` is rejected outright (see `readJsonBody`).
 */
export function withAuth<P extends Record<string, string>>(
  options: TenantRouteOptions<P>,
  handler: (input: AuthedInput<P>) => Promise<Response>,
): (request: NextRequest, routeContext: ParamsPromise<P>) => Promise<Response> {
  return async (request, routeContext) => {
    const correlationId = request.headers.get('x-correlation-id') ?? newCorrelationId();
    const route = options.name ?? new URL(request.url).pathname;

    return withLogContext({ correlationId, route }, async () => {
      try {
        // ── 1. AUTHENTICATE ────────────────────────────────────────────────
        const identity = await requireSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);

        // ── 2. RESOLVE USER ────────────────────────────────────────────────
        const user = await resolveUser(identity);

        // ── 3. RESOLVE TENANT ──────────────────────────────────────────────
        const params = await routeContext.params;
        const organizationRef = params[ORG_PARAM];
        if (!organizationRef) {
          throw new ValidationError(`Route is missing the ${ORG_PARAM} path parameter`, {
            context: { route },
          });
        }

        const { ctx, organization } = await resolveTenantContext(
          user,
          organizationRef,
          correlationId,
        );

        return await withLogContext(
          { organizationId: ctx.organizationId, userId: user.id },
          async () => {
            // ── 4. CONFINE CLIENTS TO THE PORTAL ───────────────────────────
            assertNotClient(ctx, route);

            // ── 5. AUTHORIZE ───────────────────────────────────────────────
            if (options.permission) {
              const scope = options.resource
                ? await options.resource({ request, params, ctx })
                : {};
              assertCan(ctx, options.permission, scope);
            }

            // ── 6. HANDLER (tenant-scoped data access only) ────────────────
            return await handler({ request, params, ctx, organization, user });
          },
        );
      } catch (error) {
        return handleRouteError(error, route);
      }
    });
  };
}

/**
 * Wrap a route that is authenticated but not tenant-scoped — listing the
 * organizations a user belongs to, reading their own profile, accepting an
 * invitation. These are the only routes permitted to touch `platformDb`.
 */
export function withUser<P extends Record<string, string> = Record<string, never>>(
  options: { name?: string },
  handler: (input: UnscopedInput<P>) => Promise<Response>,
): (request: NextRequest, routeContext?: ParamsPromise<P>) => Promise<Response> {
  return async (request, routeContext) => {
    const correlationId = request.headers.get('x-correlation-id') ?? newCorrelationId();
    const route = options.name ?? new URL(request.url).pathname;

    return withLogContext({ correlationId, route }, async () => {
      try {
        const identity = await requireSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
        const user = await resolveUser(identity);
        const params = ((await routeContext?.params) ?? {}) as P;

        return await withLogContext({ userId: user.id }, () => handler({ request, params, user }));
      } catch (error) {
        return handleRouteError(error, route);
      }
    });
  };
}

/** Wrap a route that requires no session at all (sign-in, webhooks, health). */
export function withPublic(
  options: { name?: string },
  handler: (request: NextRequest) => Promise<Response>,
): (request: NextRequest) => Promise<Response> {
  return async (request) => {
    const correlationId = request.headers.get('x-correlation-id') ?? newCorrelationId();
    const route = options.name ?? new URL(request.url).pathname;

    return withLogContext({ correlationId, route }, async () => {
      try {
        return await handler(request);
      } catch (error) {
        return handleRouteError(error, route);
      }
    });
  };
}

/**
 * Fields a client is never permitted to supply, because the server derives them
 * from the session and the URL. Their presence in a body is treated as an
 * attempt to override the security context, not as a harmless extra key.
 */
const SERVER_DERIVED_FIELDS = [
  'organizationId',
  'userId',
  'actorUserId',
  'isPlatformAdmin',
  'membershipStatus',
] as const;

/**
 * `role` is deliberately NOT on that list. Member management exists to set
 * roles, so a blanket ban would break the endpoint whose entire purpose it is.
 * Escalation is prevented where it actually matters — in the member service,
 * which refuses self-editing, refuses acting on an owner unless you are one,
 * and refuses granting ownership. A field-name blocklist is a much weaker
 * control than those guards, and pretending otherwise would be the mistake.
 */

/**
 * Read and validate a JSON body.
 *
 * Rejects any body carrying a server-derived field. The alternative — silently
 * stripping them — would let a probe go unnoticed; a 400 plus a logged security
 * event makes it visible.
 */
export interface ReadJsonBodyOptions {
  /**
   * Extra field names this route must refuse, beyond the global set.
   *
   * Used for fields that are legitimate payload somewhere and forbidden here —
   * `status` is a real field on a workspace update and a server-derived one on
   * a post, so the ban has to be per-route rather than global.
   */
  alsoForbid?: readonly string[];
}

export async function readJsonBody<T>(
  request: NextRequest,
  schema: { parse: (value: unknown) => T },
  options: ReadJsonBodyOptions = {},
): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError('Request body is not valid JSON', {
      userMessage: 'The request could not be read.',
    });
  }

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const forbidden = [...SERVER_DERIVED_FIELDS, ...(options.alsoForbid ?? [])];
    const offending = forbidden.filter((field) => field in raw);
    if (offending.length > 0) {
      logger.warn('request body carried server-derived fields', {
        securityEvent: true,
        fields: offending,
      });
      throw new ValidationError('Request body contains fields the server derives', {
        userMessage: 'The request contained fields that cannot be set directly.',
        details: offending.map((field) => ({
          field,
          issue: 'derived from the session and URL; cannot be supplied',
        })),
      });
    }
  }

  return schema.parse(raw);
}

/** Convenience re-export so route files import scope types from one place. */
export type { ResourceScope, PostStatus };
