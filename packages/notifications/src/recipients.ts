import type {
  BrandGrant,
  PostStatus,
  TenantContext,
  UserPrincipal,
  WorkspaceGrant,
} from '@orbit/core';
import type { TenantDb } from '@orbit/db';
import { can, type Permission } from '@orbit/rbac';
import type { NotificationType } from './types.js';

/**
 * Who gets told — and, more importantly, who does not (SRS §22; T1.15 DoD:
 * "no notification about a post you cannot see").
 *
 * A notification is a disclosure. Its title carries a post's name, an account's
 * name, sometimes a quoted review note. Sending one to somebody who could not
 * open the resource leaks exactly what the RBAC layer exists to withhold — and
 * it leaks it *by pushing it at them*, which is worse than an endpoint they
 * would have had to think to call.
 *
 * So fan-out is two questions, in this order, and both must pass:
 *
 *   1. **Interest** — does this person hold the permission that makes the event
 *      their business? Derived from the grant matrix, never a hardcoded role
 *      list, so a change to who may act changes who is told.
 *   2. **Visibility** — can this person read the underlying resource at all?
 *      Checked against the *real* policy engine (`can` from `@orbit/rbac`) with
 *      a principal rebuilt from live memberships, so there is no second
 *      implementation of the rules to drift out of step.
 *
 * Step 2 applies to named individuals too. A post's author who has since been
 * removed from the workspace is not told about it: being the creator is a reason
 * to be interested, never a reason to be allowed.
 */

/** Bound on one fan-out. Far above any real agency's staff count. */
const MAX_CANDIDATES = 200;

export interface RecipientRule {
  /** Holding this permission is what makes the event your business. */
  interestedIn: Permission;
  /**
   * Nobody is notified about something they cannot see. Omitted only where the
   * interest permission *is* the visibility permission.
   */
  visibilityRequires?: Permission;
}

/**
 * The fan-out rule per type, as a total record.
 *
 * A new notification type does not compile until someone has decided who hears
 * about it — which is the point. The alternative is a default, and every
 * plausible default is wrong: "everyone" leaks, "nobody" is a silent feature
 * that looks built.
 */
export const RECIPIENT_RULES: Record<NotificationType, RecipientRule> = {
  // Whoever can put the connection back. Not scoped to post visibility: this is
  // about the account, and who may fix it is defined by the right to reconnect.
  'social_account.needs_reconnect': { interestedIn: 'social_account:reconnect' },
  'social_account.reconnected': { interestedIn: 'social_account:reconnect' },

  // The people who can act on the gate, and only for posts they can read.
  'post.approval_requested': {
    interestedIn: 'post:approve_internal',
    visibilityRequires: 'post:read',
  },

  // Changes go back to whoever has to make them.
  'post.changes_requested': {
    interestedIn: 'post:update',
    visibilityRequires: 'post:read',
  },

  // A failed or parked publish is dealt with by whoever may retry it.
  'publishing.failed': {
    interestedIn: 'post:retry_failed',
    visibilityRequires: 'post:read',
  },
  'publishing.needs_review': {
    interestedIn: 'post:retry_failed',
    visibilityRequires: 'post:read',
  },
};

export interface RecipientScope {
  workspaceId: string;
  brandId?: string | null | undefined;
  /** Present for post-scoped events; status-restricted grants depend on it. */
  postStatus?: PostStatus | undefined;
  createdById?: string | null | undefined;
}

export interface RecipientOverrides {
  /** People with a specific stake — a post's author, its assignee. */
  includeUsers?: readonly (string | null | undefined)[] | undefined;
  /** Never tell someone about their own action. */
  excludeUsers?: readonly (string | null | undefined)[] | undefined;
}

/**
 * Resolve the users to notify, in three batched queries regardless of headcount.
 *
 * Rebuilding a principal per candidate is what lets `can()` — the same function
 * the API and the UI call — make the decision. Memberships are read live rather
 * than cached, for the same reason `resolveTenantContext` reads them live: a
 * revoked membership has to take effect immediately (decision D-004).
 */
export async function resolveRecipients(
  db: TenantDb,
  organizationId: string,
  type: NotificationType,
  scope: RecipientScope,
  overrides: RecipientOverrides = {},
): Promise<string[]> {
  const rule = RECIPIENT_RULES[type];

  const members = await db.organizationMembership.findMany({
    where: { status: 'ACTIVE' },
    select: { userId: true, role: true },
    take: MAX_CANDIDATES,
  });

  if (members.length === 0) return [];

  // Named individuals are looked for *among* the active members rather than
  // added to them, so someone who has left the organization is absent rather
  // than notified out of band.
  const explicit = toIdSet(overrides.includeUsers);
  const excluded = toIdSet(overrides.excludeUsers);

  const userIds = members.map((member) => member.userId);

  const [workspaces, brands] = await Promise.all([
    db.workspaceMembership.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, workspaceId: true, role: true },
    }),
    db.brandAssignment.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, brandId: true, canApprove: true },
    }),
  ]);

  const workspacesByUser = groupBy(workspaces, (w) => w.userId);
  const brandsByUser = groupBy(brands, (b) => b.userId);

  const resource = {
    workspaceId: scope.workspaceId,
    ...(scope.brandId ? { brandId: scope.brandId } : {}),
    ...(scope.postStatus ? { status: scope.postStatus } : {}),
    ...(scope.createdById !== undefined ? { createdById: scope.createdById } : {}),
  };

  const recipients: string[] = [];

  for (const member of members) {
    if (excluded.has(member.userId)) continue;

    const ctx = principalContext(organizationId, member, workspacesByUser, brandsByUser);

    // Visibility first — the check that must never be skipped. Being named
    // explicitly grants interest, never access.
    if (rule.visibilityRequires && !can(ctx, rule.visibilityRequires, resource)) {
      continue;
    }

    if (!explicit.has(member.userId) && !can(ctx, rule.interestedIn, resource)) {
      continue;
    }

    recipients.push(member.userId);
  }

  return recipients;
}

type Member = { userId: string; role: UserPrincipal['organizationRole'] };

function principalContext(
  organizationId: string,
  member: Member,
  workspacesByUser: Map<string, WorkspaceGrant[]>,
  brandsByUser: Map<string, BrandGrant[]>,
): TenantContext {
  const principal: UserPrincipal = {
    kind: 'USER',
    userId: member.userId,
    // Not consulted by any decision `can()` makes. Deliberately blank rather
    // than fetched: a fan-out has no business assembling contact details.
    email: '',
    // Never inflated here. Platform admins are not tenant superusers
    // (docs/RBAC.md §1 rule 4), and a notification carries tenant content.
    isPlatformAdmin: false,
    organizationRole: member.role,
    membershipStatus: 'ACTIVE',
    workspaces: workspacesByUser.get(member.userId) ?? [],
    brands: brandsByUser.get(member.userId) ?? [],
  };

  return { organizationId, principal, correlationId: 'notification-fanout' };
}

function toIdSet(values: readonly (string | null | undefined)[] | undefined): Set<string> {
  return new Set((values ?? []).filter((id): id is string => typeof id === 'string'));
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const existing = map.get(key(row));
    if (existing) existing.push(row);
    else map.set(key(row), [row]);
  }
  return map;
}
