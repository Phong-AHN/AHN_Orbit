import type { Metadata } from 'next';
import { accessibleWorkspaceIds, isUserPrincipal } from '@orbit/core';
import { Card, CardBody, Empty, PageHeader, PermissionDenied, Section } from '@orbit/ui';
import { pageCan, requirePageContext } from '@/server/page-context';
import { listMembers } from '@/features/tenancy/members';
import { listInvitations } from '@/features/tenancy/invitations';
import { listWorkspaces } from '@/features/tenancy/service';
import { InviteForm } from '@/features/tenancy/ui/invite-form';
import { MemberRow } from '@/features/tenancy/ui/member-row';
import { PendingInvitations } from '@/features/tenancy/ui/pending-invitations';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Team' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
}

/**
 * Who is in this organization, who has been asked, and how somebody else gets in.
 *
 * Three states rather than one list: **active** people, **pending**
 * invitations, and people who are here but not yet accepted. Pending
 * invitations were previously invisible, which meant an invitation whose link
 * was lost left no trace — the only recovery was to send another and hope.
 *
 * Roles offered for assignment stop short of Owner. Granting ownership is an
 * ownership transfer in all but name and the service reserves it to owners; a
 * select that listed it would be a control that fails for most of the people
 * who can see it.
 */
export default async function MembersPage({ params }: PageProps) {
  const { orgSlug } = await params;
  const { ctx, organization } = await requirePageContext(orgSlug);

  if (!pageCan(ctx, 'member:list')) {
    return (
      <main id="main" className="mx-auto max-w-4xl px-6 py-10">
        <PermissionDenied action="see the team" />
      </main>
    );
  }

  const canInvite = pageCan(ctx, 'member:invite');
  const canChangeRole = pageCan(ctx, 'member:update_role');
  const canRemove = pageCan(ctx, 'member:remove');

  const [members, invitations, workspaces] = await Promise.all([
    listMembers(ctx),
    canInvite ? listInvitations(ctx) : Promise.resolve([]),
    canInvite ? listWorkspaces(ctx, accessibleWorkspaceIds(ctx)) : Promise.resolve([]),
  ]);

  const selfId = isUserPrincipal(ctx.principal) ? ctx.principal.userId : null;

  const active = members.filter((member) => member.status === 'ACTIVE');
  const inactive = members.filter((member) => member.status !== 'ACTIVE');

  return (
    <main id="main" className="mx-auto max-w-4xl space-y-8 px-6 py-10">
      <PageHeader
        eyebrow={organization.name}
        title="Team"
        description="Agency staff, and the client reviewers invited to their own workspaces."
        actions={
          canInvite ? (
            <InviteForm
              orgSlug={orgSlug}
              workspaces={workspaces.map((workspace) => ({
                id: workspace.id,
                name: workspace.name,
              }))}
            />
          ) : null
        }
      />

      <Section
        title={`${active.length} ${active.length === 1 ? 'person' : 'people'}`}
        description="Everyone with access right now."
      >
        {members.length === 0 ? (
          <Empty title="Nobody here yet" description="Invite the first person to your agency." />
        ) : (
          <ul className="space-y-2">
            {[...active, ...inactive].map((member) => (
              <li key={member.id}>
                <Card>
                  <CardBody>
                    <MemberRow
                      orgSlug={orgSlug}
                      member={{
                        userId: member.user.id,
                        name: member.user.name,
                        email: member.user.email,
                        role: member.role,
                        status: member.status,
                      }}
                      assignableRoles={ASSIGNABLE_ROLES}
                      canChangeRole={canChangeRole}
                      canRemove={canRemove}
                      isSelf={member.user.id === selfId}
                    />
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {canInvite && invitations.length > 0 ? (
        <Section
          title="Invited, not yet joined"
          description="These links work until they are used, withdrawn, or expire."
        >
          <PendingInvitations
            orgSlug={orgSlug}
            invitations={invitations.map((invitation) => ({
              id: invitation.id,
              email: invitation.email,
              role: invitation.role,
              expiresAt: invitation.expiresAt.toISOString(),
              createdAt: invitation.createdAt.toISOString(),
            }))}
            canRevoke={canInvite}
          />
        </Section>
      ) : null}
    </main>
  );
}

/**
 * Roles a person may be moved to from this screen.
 *
 * Owner is absent on purpose: the service treats granting it as an ownership
 * transfer and reserves it to owners, so offering it here would be a control
 * that refuses most of the people who can see it. Transferring ownership is its
 * own deliberate act.
 */
const ASSIGNABLE_ROLES = [
  { value: 'ADMIN', label: 'Admin' },
  { value: 'ACCOUNT_MANAGER', label: 'Account manager' },
  { value: 'CONTENT_CREATOR', label: 'Content creator' },
  { value: 'APPROVER', label: 'Approver' },
  { value: 'CLIENT', label: 'Client' },
] as const;
