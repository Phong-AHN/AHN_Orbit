import {
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  clock,
  isUuid,
  newCorrelationId,
  type BrandGrant,
  type TenantContext,
  type UserPrincipal,
  type WorkspaceGrant,
} from '@orbit/core';
import { platformDb } from '@orbit/db';
import { logger } from '@orbit/observability';
import type { VerifiedIdentity } from './identity.js';

/**
 * User and tenant resolution (T1.2).
 *
 * The order is the whole point (docs/ARCHITECTURE.md §1.3):
 *
 *   1. authenticate   — the session cookie yields a VerifiedIdentity
 *   2. resolve user   — firebaseUid → User row (the id is ours, not theirs)
 *   3. resolve tenant — organization id from the URL, cross-checked against
 *                       OrganizationMembership; no membership ⇒ 404
 *   4. authorize      — @orbit/rbac, against the resolved principal
 *   5. data access    — withTenant(ctx), which is scoped and RLS-armed
 *
 * Nothing here reads a user id, organization id, role, or membership from the
 * request body. The only thing the caller supplies is the organization *slug
 * or id in the path*, and that is treated as a claim to be checked, never as
 * an assertion to be believed.
 */

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  timezone: string;
  isPlatformAdmin: boolean;
}

/**
 * Map a verified identity onto our own User row, creating it on first sign-in.
 *
 * Uses `platformDb` deliberately: this runs *before* a tenant exists, and the
 * User table is not tenant-scoped (a person may belong to several
 * organizations). Lookup is by `firebaseUid` — never by an email supplied in a
 * request — so a changed email address cannot be used to land on someone
 * else's account.
 */
export async function resolveUser(identity: VerifiedIdentity): Promise<AuthenticatedUser> {
  const email = identity.email.toLowerCase();

  const existing = await platformDb.user.findUnique({
    where: { firebaseUid: identity.uid },
    select: {
      id: true,
      email: true,
      name: true,
      avatarUrl: true,
      timezone: true,
      isPlatformAdmin: true,
      deletedAt: true,
    },
  });

  if (existing) {
    if (existing.deletedAt) {
      throw new UnauthenticatedError('Account is no longer active', {
        context: { reason: 'user soft-deleted', userId: existing.id },
      });
    }

    // Keep the email in step with the identity provider, and record presence.
    if (existing.email !== email) {
      await platformDb.user.update({
        where: { id: existing.id },
        data: { email, lastSeenAt: clock.now() },
      });
    } else {
      await platformDb.user.update({
        where: { id: existing.id },
        data: { lastSeenAt: clock.now() },
      });
    }

    return {
      id: existing.id,
      email,
      name: existing.name,
      avatarUrl: existing.avatarUrl,
      timezone: existing.timezone,
      isPlatformAdmin: existing.isPlatformAdmin,
    };
  }

  // First sign-in. An email already attached to a different firebaseUid means
  // the same person arrived through a second sign-in method; adopt the row
  // rather than creating a duplicate identity.
  const byEmail = await platformDb.user.findUnique({
    where: { email },
    select: { id: true, firebaseUid: true },
  });

  if (byEmail) {
    logger.warn('linking existing user to a new identity', {
      userId: byEmail.id,
      previousUid: byEmail.firebaseUid,
      newUid: identity.uid,
    });
  }

  const user = byEmail
    ? await platformDb.user.update({
        where: { id: byEmail.id },
        data: { firebaseUid: identity.uid, lastSeenAt: clock.now() },
        select: {
          id: true,
          email: true,
          name: true,
          avatarUrl: true,
          timezone: true,
          isPlatformAdmin: true,
        },
      })
    : await platformDb.user.create({
        data: {
          firebaseUid: identity.uid,
          email,
          name: identity.name ?? null,
          avatarUrl: identity.picture ?? null,
          lastSeenAt: clock.now(),
          // isPlatformAdmin is never set from a token claim — only by a
          // deliberate database change (docs/RBAC.md §1 rule 2).
        },
        select: {
          id: true,
          email: true,
          name: true,
          avatarUrl: true,
          timezone: true,
          isPlatformAdmin: true,
        },
      });

  logger.info('user provisioned', { userId: user.id, linked: Boolean(byEmail) });
  return user;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  timezone: string;
}

/**
 * Resolve the tenant context for a user in one organization.
 *
 * `organizationRef` is whatever the URL carried — an id or a slug. It is
 * resolved and then **cross-checked against the user's memberships**. A user
 * with no active membership gets `NotFoundError`, not `ForbiddenError`: a 403
 * would confirm the organization exists (docs/API.md §1).
 */
export async function resolveTenantContext(
  user: AuthenticatedUser,
  organizationRef: string,
  correlationId: string = newCorrelationId(),
): Promise<{ ctx: TenantContext; organization: OrganizationSummary }> {
  const membership = await platformDb.organizationMembership.findFirst({
    where: {
      userId: user.id,
      organization: isUuid(organizationRef)
        ? { id: organizationRef, deletedAt: null }
        : { slug: organizationRef, deletedAt: null },
    },
    select: {
      role: true,
      status: true,
      organization: { select: { id: true, name: true, slug: true, timezone: true } },
    },
  });

  if (!membership) {
    // Indistinguishable from "no such organization" — deliberately.
    logger.warn('tenant resolution denied', {
      userId: user.id,
      organizationRef,
      reason: 'no membership',
    });
    throw new NotFoundError('Organization', {
      context: { userId: user.id, organizationRef, reason: 'no membership' },
    });
  }

  if (membership.status !== 'ACTIVE') {
    throw new ForbiddenError('Membership is not active', {
      userMessage:
        membership.status === 'INVITED'
          ? 'Accept your invitation to this organization before continuing.'
          : 'Your access to this organization has been suspended.',
      context: { userId: user.id, status: membership.status },
    });
  }

  const organizationId = membership.organization.id;

  // Workspace and brand grants, read fresh. Never taken from a token claim,
  // which could be up to an hour stale (decision D-004).
  const [workspaces, brands] = await Promise.all([
    platformDb.workspaceMembership.findMany({
      where: { userId: user.id, organizationId, workspace: { deletedAt: null } },
      select: { workspaceId: true, role: true },
    }),
    platformDb.brandAssignment.findMany({
      where: { userId: user.id, organizationId, brand: { deletedAt: null } },
      select: { brandId: true, canApprove: true },
    }),
  ]);

  const principal: UserPrincipal = {
    kind: 'USER',
    userId: user.id,
    email: user.email,
    isPlatformAdmin: user.isPlatformAdmin,
    organizationRole: membership.role,
    membershipStatus: membership.status,
    workspaces: workspaces satisfies WorkspaceGrant[],
    brands: brands satisfies BrandGrant[],
  };

  return {
    ctx: { organizationId, principal, correlationId },
    organization: membership.organization,
  };
}

/** Organizations a user may choose between, for the org switcher. */
export async function listAccessibleOrganizations(
  userId: string,
): Promise<Array<OrganizationSummary & { role: string }>> {
  const memberships = await platformDb.organizationMembership.findMany({
    where: { userId, status: 'ACTIVE', organization: { deletedAt: null } },
    select: {
      role: true,
      organization: { select: { id: true, name: true, slug: true, timezone: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  return memberships.map((m) => ({ ...m.organization, role: m.role }));
}
