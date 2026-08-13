import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  clock,
  newOpaqueToken,
  type OrganizationRole,
  type TenantContext,
} from '@orbit/core';
import { platformDb, withTenant } from '@orbit/db';
import { logger } from '@orbit/observability';
import { audit, type AuditInput } from '@/server/audit';
import type { CreateInvitationInput } from './contracts';

/**
 * Invitations (T1.4).
 *
 * Security properties, in order of importance:
 *
 *  • **Only the hash is stored.** The token exists in the invitation email and
 *    nowhere else, so a database read cannot be turned into an account.
 *  • **Single use and time-boxed.** Acceptance is a conditional update, so two
 *    simultaneous redemptions cannot both win.
 *  • **The token identifies the invitation; the session identifies the user.**
 *    Acceptance requires an authenticated session, and the invited email must
 *    match it — a leaked link cannot be redeemed by whoever finds it.
 *  • **Nobody can invite above themselves.** An Account Manager may invite
 *    Clients into their own workspaces and nothing more.
 */

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Roles each org role may hand out. Absent ⇒ may not invite at all.
 * Deliberately narrower than "any role you hold": privilege escalation by
 * invitation is a classic path, so an Account Manager cannot mint an Admin.
 */
const INVITABLE_ROLES: Partial<Record<OrganizationRole, readonly OrganizationRole[]>> = {
  OWNER: ['ADMIN', 'ACCOUNT_MANAGER', 'CONTENT_CREATOR', 'APPROVER', 'CLIENT'],
  ADMIN: ['ACCOUNT_MANAGER', 'CONTENT_CREATOR', 'APPROVER', 'CLIENT'],
  ACCOUNT_MANAGER: ['CLIENT'],
};

export function assertMayInviteRole(ctx: TenantContext, role: OrganizationRole): void {
  if (ctx.principal.kind !== 'USER') {
    throw new ForbiddenError('System principals cannot issue invitations');
  }

  const allowed = INVITABLE_ROLES[ctx.principal.organizationRole] ?? [];
  if (!allowed.includes(role)) {
    throw new ForbiddenError(`Cannot invite a ${role}`, {
      userMessage: `You can't invite someone as ${role.toLowerCase().replace(/_/g, ' ')}.`,
      context: { actorRole: ctx.principal.organizationRole, requestedRole: role },
    });
  }

  // OWNER is never invitable — ownership transfers explicitly, so an invitation
  // can never create a second owner behind the current one's back.
  if ((role as string) === 'OWNER') {
    throw new ForbiddenError('Ownership is transferred, not invited');
  }
}

export async function createInvitation(
  ctx: TenantContext,
  input: CreateInvitationInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
): Promise<{ id: string; email: string; role: OrganizationRole; expiresAt: Date; token: string }> {
  assertMayInviteRole(ctx, input.role);

  if (input.role === 'CLIENT' && input.workspaceIds.length === 0) {
    throw new ValidationError('A client invitation must name at least one workspace', {
      userMessage: 'Choose which client workspace this person should see.',
      details: [{ field: 'workspaceIds', issue: 'required for the Client role' }],
    });
  }

  return withTenant(ctx, async (db) => {
    // Every named workspace must exist *in this tenant*. Scoped, so an id from
    // another organization is simply absent and the count will not match.
    if (input.workspaceIds.length > 0) {
      const found = await db.workspace.count({
        where: { id: { in: input.workspaceIds }, deletedAt: null },
      });
      if (found !== input.workspaceIds.length) {
        throw new NotFoundError('Workspace', {
          context: { requested: input.workspaceIds.length, found },
        });
      }

      // An Account Manager may only invite into workspaces they manage.
      if (ctx.principal.kind === 'USER' && ctx.principal.organizationRole === 'ACCOUNT_MANAGER') {
        const own = new Set(ctx.principal.workspaces.map((w) => w.workspaceId));
        const outside = input.workspaceIds.filter((id) => !own.has(id));
        if (outside.length > 0) {
          throw new ForbiddenError('Cannot invite into a workspace you do not manage', {
            context: { outside },
          });
        }
      }
    }

    const existingMember = await db.organizationMembership.findFirst({
      where: { user: { email: input.email } },
      select: { id: true, status: true },
    });
    if (existingMember) {
      throw new ConflictError('Already a member of this organization', {
        userMessage: 'That person is already part of this organization.',
      });
    }

    const pending = await db.invitation.findFirst({
      where: {
        email: input.email,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: clock.now() },
      },
      select: { id: true },
    });
    if (pending) {
      throw new ConflictError('An invitation is already pending for this address', {
        userMessage: 'They already have a pending invitation. Revoke it first to send a new one.',
      });
    }

    // Generated here, returned to the caller once, and never stored in the clear.
    const token = newOpaqueToken(32);

    const invitation = await db.invitation.create({
      data: {
        organizationId: ctx.organizationId,
        email: input.email,
        role: input.role,
        workspaceIds: input.workspaceIds,
        tokenHash: hashToken(token),
        expiresAt: new Date(clock.nowMs() + INVITATION_TTL_MS),
        invitedById: ctx.principal.kind === 'USER' ? ctx.principal.userId : null,
      },
      select: { id: true, email: true, role: true, expiresAt: true },
    });

    await audit(db, ctx, {
      action: 'invitation.created',
      resourceType: 'Invitation',
      resourceId: invitation.id,
      // The token is deliberately absent from the audit row.
      after: { email: invitation.email, role: invitation.role },
      ...fingerprint,
    });

    return { ...invitation, token };
  });
}

export async function listInvitations(ctx: TenantContext) {
  return withTenant(ctx, (db) =>
    db.invitation.findMany({
      where: { acceptedAt: null, revokedAt: null },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
  );
}

export async function revokeInvitation(
  ctx: TenantContext,
  invitationId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const invitation = await db.invitation.findFirst({
      where: { id: invitationId, acceptedAt: null, revokedAt: null },
      select: { id: true, email: true },
    });
    if (!invitation) throw new NotFoundError('Invitation');

    await db.invitation.update({ where: { id: invitationId }, data: { revokedAt: clock.now() } });

    await audit(db, ctx, {
      action: 'invitation.revoked',
      resourceType: 'Invitation',
      resourceId: invitationId,
      before: { email: invitation.email },
      ...fingerprint,
    });
  });
}

/**
 * Redeem an invitation.
 *
 * Runs on `platformDb` because the invitee has no membership yet, so there is
 * no tenant context to scope to — the token *is* the authorization to join, and
 * the session proves who is joining.
 */
export async function acceptInvitation(
  user: { id: string; email: string },
  token: string,
  correlationId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const providedHash = hashToken(token);

  const invitation = await platformDb.invitation.findUnique({
    where: { tokenHash: providedHash },
    select: {
      id: true,
      organizationId: true,
      email: true,
      role: true,
      workspaceIds: true,
      tokenHash: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      organization: { select: { id: true, name: true, slug: true, deletedAt: true } },
    },
  });

  // One generic failure for every reason an invitation is unusable, so the
  // endpoint cannot be used to probe which tokens exist.
  const unusable = () => {
    logger.warn('invitation redemption refused', {
      securityEvent: true,
      userId: user.id,
      found: Boolean(invitation),
    });
    return new NotFoundError('Invitation', {
      userMessage: 'That invitation is no longer valid. Ask for a new one.',
    });
  };

  if (!invitation) throw unusable();

  // Constant-time compare on the hashes, so redemption timing does not leak
  // how much of a guessed token was correct.
  const a = Buffer.from(invitation.tokenHash);
  const b = Buffer.from(providedHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw unusable();

  if (
    invitation.acceptedAt ||
    invitation.revokedAt ||
    invitation.expiresAt <= clock.now() ||
    invitation.organization.deletedAt
  ) {
    throw unusable();
  }

  // The invitation names an address; the session proves the address. A leaked
  // link is worthless to anyone else.
  if (invitation.email.toLowerCase() !== user.email.toLowerCase()) {
    logger.warn('invitation email mismatch', {
      securityEvent: true,
      userId: user.id,
      invitationId: invitation.id,
    });
    throw new ForbiddenError('Invitation was issued to a different address', {
      userMessage: `This invitation was sent to ${invitation.email}. Sign in with that address to accept it.`,
    });
  }

  return platformDb.$transaction(async (tx) => {
    // Single-use, enforced by the update predicate rather than by the read
    // above: two concurrent redemptions cannot both match `acceptedAt: null`.
    const claimed = await tx.invitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: clock.now() },
    });
    if (claimed.count === 0) throw unusable();

    await tx.organizationMembership.create({
      data: {
        organizationId: invitation.organizationId,
        userId: user.id,
        role: invitation.role,
        status: 'ACTIVE',
        acceptedAt: clock.now(),
      },
    });

    if (invitation.workspaceIds.length > 0) {
      const isClient = invitation.role === 'CLIENT';
      await tx.workspaceMembership.createMany({
        data: invitation.workspaceIds.map((workspaceId) => ({
          organizationId: invitation.organizationId,
          workspaceId,
          userId: user.id,
          role: isClient ? ('CLIENT_APPROVER' as const) : ('CONTRIBUTOR' as const),
        })),
        skipDuplicates: true,
      });
    }

    await tx.auditLog.create({
      data: {
        organizationId: invitation.organizationId,
        actorUserId: user.id,
        actorType: 'USER',
        action: 'invitation.accepted',
        resourceType: 'Invitation',
        resourceId: invitation.id,
        after: { role: invitation.role, workspaces: invitation.workspaceIds.length },
        correlationId,
        ip: fingerprint.ip ?? null,
        userAgent: fingerprint.userAgent ?? null,
      },
    });

    return {
      organization: {
        id: invitation.organization.id,
        name: invitation.organization.name,
        slug: invitation.organization.slug,
      },
      role: invitation.role,
    };
  });
}
