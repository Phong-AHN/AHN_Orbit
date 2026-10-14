import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  isUserPrincipal,
  type OrganizationRole,
  type TenantContext,
  type WorkspaceRole,
} from '@orbit/core';
import { withTenant, type TenantDb } from '@orbit/db';
import { audit, type AuditInput } from '@/server/audit';

/**
 * Member management (T1.4).
 *
 * Membership is the thing every other permission hangs off, so the guards here
 * are deliberately stricter than the raw permission check:
 *
 *  • **Nobody edits their own role.** Otherwise `member:update_role` is a
 *    self-promotion button, and an Admin could make themselves Owner.
 *  • **Only an Owner may touch an Owner**, or grant ownership. An Admin holds
 *    `member:update_role`, but not over the person above them.
 *  • **The last Owner cannot be demoted or removed**, at all, by anyone —
 *    an organization with no owner cannot be recovered without support.
 *  • **Account Managers manage clients only**, and only inside workspaces they
 *    already belong to.
 */

interface TargetMembership {
  id: string;
  userId: string;
  role: OrganizationRole;
  status: string;
}

async function requireMembership(db: TenantDb, userId: string): Promise<TargetMembership> {
  const membership = await db.organizationMembership.findFirst({
    where: { userId },
    select: { id: true, userId: true, role: true, status: true },
  });

  // Scoped, so a user who belongs only to another organization is simply not
  // found here — the same 404 as a user who does not exist at all.
  if (!membership) throw new NotFoundError('Member');
  return membership;
}

function actorRole(ctx: TenantContext): OrganizationRole {
  if (!isUserPrincipal(ctx.principal)) {
    throw new ForbiddenError('System principals cannot manage members');
  }
  return ctx.principal.organizationRole;
}

function actorId(ctx: TenantContext): string {
  if (!isUserPrincipal(ctx.principal)) {
    throw new ForbiddenError('System principals cannot manage members');
  }
  return ctx.principal.userId;
}

/** Shared guard for both role changes and removals. */
function assertMayActOn(ctx: TenantContext, target: TargetMembership): void {
  if (target.userId === actorId(ctx)) {
    throw new ForbiddenError('Cannot change your own membership', {
      userMessage: 'You can’t change your own role or remove yourself. Ask another owner or admin.',
      context: { reason: 'self-management' },
    });
  }

  if (target.role === 'OWNER' && actorRole(ctx) !== 'OWNER') {
    throw new ForbiddenError('Only an owner may act on an owner', {
      userMessage: 'Only an organization owner can change or remove another owner.',
      context: { actorRole: actorRole(ctx), targetRole: target.role },
    });
  }
}

async function countOwners(db: TenantDb): Promise<number> {
  return db.organizationMembership.count({ where: { role: 'OWNER', status: 'ACTIVE' } });
}

// ── Organization members ────────────────────────────────────────────────────

export async function listMembers(ctx: TenantContext) {
  return withTenant(ctx, (db) =>
    db.organizationMembership.findMany({
      select: {
        id: true,
        role: true,
        status: true,
        acceptedAt: true,
        createdAt: true,
        user: { select: { id: true, email: true, name: true, avatarUrl: true, lastSeenAt: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
  );
}

export async function updateMemberRole(
  ctx: TenantContext,
  userId: string,
  role: OrganizationRole,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const target = await requireMembership(db, userId);
    assertMayActOn(ctx, target);

    // Granting ownership is an ownership transfer in all but name, so it is
    // reserved to owners regardless of who holds member:update_role.
    if (role === 'OWNER' && actorRole(ctx) !== 'OWNER') {
      throw new ForbiddenError('Only an owner may grant ownership', {
        userMessage: 'Only an organization owner can make someone else an owner.',
        context: { actorRole: actorRole(ctx) },
      });
    }

    if (target.role === role) return { userId, role };

    if (target.role === 'OWNER' && (await countOwners(db)) <= 1) {
      throw new ConflictError('Organization would be left with no owner', {
        userMessage:
          'This is the only owner. Make someone else an owner first, then change this role.',
      });
    }

    await db.organizationMembership.update({
      where: { id: target.id },
      data: { role },
    });

    // A role change is a client's role change too, so any workspace grants that
    // no longer make sense are removed rather than left dangling: an ex-client
    // promoted to staff should not keep a CLIENT_APPROVER seat.
    const becameInternal = target.role === 'CLIENT' && role !== 'CLIENT';
    const becameClient = target.role !== 'CLIENT' && role === 'CLIENT';
    if (becameInternal || becameClient) {
      await db.workspaceMembership.deleteMany({ where: { userId } });
    }

    await audit(db, ctx, {
      action: 'member.role_changed',
      resourceType: 'OrganizationMembership',
      resourceId: target.id,
      before: { userId, role: target.role },
      after: { userId, role },
      ...fingerprint,
    });

    return { userId, role };
  });
}

/**
 * Hand the organization to somebody else (SRS §4).
 *
 * ## Why this is not two role changes
 *
 * It already *was* two: an owner could promote somebody to `OWNER` with
 * `updateMemberRole`, then demote themselves. Both calls are permitted and the
 * end state is correct — but the two-step version has a failure mode the
 * permission matrix cannot express. **If the second call never happens the
 * organization keeps two owners, silently and permanently.** Nothing reports
 * it, and the next person to read the member list cannot tell a half-finished
 * transfer from a deliberate co-ownership.
 *
 * One transaction means the organization has exactly one owner before and
 * exactly one after, with no reachable state in between.
 *
 * ## Why it has its own permission
 *
 * `org:transfer_ownership` is granted to `OWNER` and **withheld from `ADMIN`**,
 * unlike `member:update_role` which both hold. That distinction was already in
 * the matrix with nothing using it; giving away the organization is a different
 * act from changing a colleague's role, and now the code says so too.
 *
 * ## The outgoing owner becomes an Admin, not nothing
 *
 * Removing them would lock the person who just did the handover out of the
 * agency they built. `ADMIN` keeps them able to work and is the role that
 * differs from `OWNER` by exactly the three things an ex-owner should no longer
 * hold: deleting the organization, transferring it again, and billing.
 */
export async function transferOwnership(
  ctx: TenantContext,
  userId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    // Checked here as well as by the route's permission gate: this function is
    // the thing that must be safe, and a future caller may not be a route.
    if (actorRole(ctx) !== 'OWNER') {
      throw new ForbiddenError('Only an owner may transfer ownership', {
        userMessage: 'Only an organization owner can hand the organization to someone else.',
        context: { actorRole: actorRole(ctx) },
      });
    }

    const actor = actorId(ctx);
    const target = await requireMembership(db, userId);

    if (target.userId === actor) {
      throw new ConflictError('Already the owner', {
        userMessage: 'You already own this organization.',
      });
    }

    // An invitation that has not been accepted is not a person who can run the
    // agency yet, and handing it to one would leave nobody able to act.
    if (target.status !== 'ACTIVE') {
      throw new ConflictError('Member is not active', {
        userMessage:
          'That person has not accepted their invitation yet. They have to join before they can own the organization.',
      });
    }

    /**
     * A client cannot be handed the agency.
     *
     * `CLIENT` is the role for the people an agency works *for*: the portal is
     * built so they see one workspace and nothing about the agency itself.
     * Promoting one straight to owner is almost certainly a misclick on a
     * member list, and the cost of being wrong is total. Refused with the way
     * out rather than silently allowed.
     */
    if (target.role === 'CLIENT') {
      throw new ConflictError('A client cannot own the organization', {
        userMessage:
          'That member is a client. Change their role to Admin first if they really should own this organization.',
      });
    }

    await db.organizationMembership.update({
      where: { id: target.id },
      data: { role: 'OWNER' },
    });

    const outgoing = await db.organizationMembership.findFirst({
      where: { userId: actor },
      select: { id: true },
    });

    // Scoped lookup, so this cannot be missing for a real actor — but the
    // transaction must not silently skip the demotion if it ever is.
    if (!outgoing) throw new NotFoundError('Your own membership');

    await db.organizationMembership.update({
      where: { id: outgoing.id },
      data: { role: 'ADMIN' },
    });

    // One entry, not two: a reader of the audit log needs to see a transfer,
    // and two adjacent role changes are what this used to look like.
    await audit(db, ctx, {
      action: 'org.ownership_transferred',
      resourceType: 'Organization',
      resourceId: ctx.organizationId,
      before: { ownerUserId: actor, targetRole: target.role },
      after: { ownerUserId: userId, previousOwnerRole: 'ADMIN' },
      ...fingerprint,
    });

    return { ownerUserId: userId, previousOwnerRole: 'ADMIN' as const };
  });
}

export async function removeMember(
  ctx: TenantContext,
  userId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const target = await requireMembership(db, userId);
    assertMayActOn(ctx, target);

    if (target.role === 'OWNER' && (await countOwners(db)) <= 1) {
      throw new ConflictError('Organization would be left with no owner', {
        userMessage: 'This is the only owner. Make someone else an owner before removing them.',
      });
    }

    // Workspace grants go with the membership; leaving them would let the user
    // back in if they were ever re-added to the organization.
    await db.workspaceMembership.deleteMany({ where: { userId } });
    await db.brandAssignment.deleteMany({ where: { userId } });
    await db.organizationMembership.delete({ where: { id: target.id } });

    await audit(db, ctx, {
      action: 'member.removed',
      resourceType: 'OrganizationMembership',
      resourceId: target.id,
      before: { userId, role: target.role },
      ...fingerprint,
    });
  });
}

// ── Workspace members ───────────────────────────────────────────────────────

export async function listWorkspaceMembers(ctx: TenantContext, workspaceId: string) {
  return withTenant(ctx, async (db) => {
    const workspace = await db.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!workspace) throw new NotFoundError('Workspace');

    return db.workspaceMembership.findMany({
      where: { workspaceId },
      select: {
        id: true,
        role: true,
        createdAt: true,
        user: { select: { id: true, email: true, name: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  });
}

/**
 * An Account Manager may staff their own workspaces with clients, and nothing
 * else. Owners and Admins are unrestricted within the organization.
 */
function assertMayStaffWorkspace(
  ctx: TenantContext,
  workspaceId: string,
  targetOrgRole: OrganizationRole,
): void {
  const role = actorRole(ctx);
  if (role === 'OWNER' || role === 'ADMIN') return;

  if (role !== 'ACCOUNT_MANAGER') {
    throw new ForbiddenError('Cannot manage workspace members');
  }

  const inWorkspace =
    isUserPrincipal(ctx.principal) &&
    ctx.principal.workspaces.some((w) => w.workspaceId === workspaceId);

  if (!inWorkspace) {
    throw new ForbiddenError('Cannot manage a workspace you do not belong to', {
      context: { workspaceId },
    });
  }

  if (targetOrgRole !== 'CLIENT') {
    throw new ForbiddenError('Account managers may only assign client users', {
      userMessage: 'You can add client users to this workspace, but not agency staff.',
      context: { targetOrgRole },
    });
  }
}

export async function addWorkspaceMember(
  ctx: TenantContext,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const workspace = await db.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!workspace) throw new NotFoundError('Workspace');

    // The target must already belong to this organization. This is also the
    // check that stops a user from another tenant being granted a seat — the
    // scoped lookup simply does not find them.
    const target = await requireMembership(db, userId);
    if (target.status !== 'ACTIVE') {
      throw new ConflictError('That person has not accepted their invitation yet');
    }

    assertMayStaffWorkspace(ctx, workspaceId, target.role);

    // A client must never hold an internal workspace role, and vice versa —
    // otherwise the portal confinement in RBAC could be bypassed by a seat.
    const clientRoles: readonly WorkspaceRole[] = ['CLIENT_VIEWER', 'CLIENT_APPROVER'];
    const isClientRole = clientRoles.includes(role);
    if ((target.role === 'CLIENT') !== isClientRole) {
      throw new ForbiddenError('Workspace role does not match the member’s organization role', {
        userMessage:
          target.role === 'CLIENT'
            ? 'Client users can only be given client access to a workspace.'
            : 'Agency staff cannot be given client access.',
        context: { organizationRole: target.role, workspaceRole: role },
      });
    }

    const existing = await db.workspaceMembership.findFirst({
      where: { workspaceId, userId },
      select: { id: true, role: true },
    });

    if (existing) {
      if (existing.role === role) return { workspaceId, userId, role };
      await db.workspaceMembership.update({ where: { id: existing.id }, data: { role } });
    } else {
      await db.workspaceMembership.create({
        data: { organizationId: ctx.organizationId, workspaceId, userId, role },
      });
    }

    await audit(db, ctx, {
      action: existing ? 'workspace_member.role_changed' : 'workspace_member.added',
      resourceType: 'WorkspaceMembership',
      resourceId: existing?.id,
      workspaceId,
      before: existing ? { userId, role: existing.role } : undefined,
      after: { userId, role },
      ...fingerprint,
    });

    return { workspaceId, userId, role };
  });
}

export async function removeWorkspaceMember(
  ctx: TenantContext,
  workspaceId: string,
  userId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const membership = await db.workspaceMembership.findFirst({
      where: { workspaceId, userId },
      select: { id: true, role: true },
    });
    if (!membership) throw new NotFoundError('Workspace member');

    const target = await requireMembership(db, userId);
    assertMayStaffWorkspace(ctx, workspaceId, target.role);

    await db.workspaceMembership.delete({ where: { id: membership.id } });

    await audit(db, ctx, {
      action: 'workspace_member.removed',
      resourceType: 'WorkspaceMembership',
      resourceId: membership.id,
      workspaceId,
      before: { userId, role: membership.role },
      ...fingerprint,
    });
  });
}
