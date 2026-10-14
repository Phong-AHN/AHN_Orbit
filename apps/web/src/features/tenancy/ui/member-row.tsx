'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, ConfirmDialog, Field, Input, Select, useToast } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * One person on the team, and what can be done to them (SRS §5).
 *
 * Two actions, and they are deliberately unalike in weight. Changing a role is
 * a select that saves on change — reversible, low stakes, and a confirmation
 * for it would be noise. **Removing somebody is a confirmation dialog** that
 * names them and says what it costs, because it is not reversible from this
 * screen: they have to be invited back and accept again.
 *
 * The Owner is not offered either control. An organization that can demote or
 * remove its last owner is an organization that can strand itself, and the API
 * refuses it anyway — showing a control that will fail is worse than not
 * showing one.
 *
 * **A third action, heavier than both:** handing the organization over. It is
 * the only one the person performing it cannot undo — the moment it lands they
 * are an Admin, and an Admin may not transfer ownership. So it asks them to
 * type the name of the person taking over, which is the one confirmation that
 * cannot be clicked through by muscle memory.
 */

export interface MemberRowProps {
  orgSlug: string;
  member: {
    userId: string;
    name: string | null;
    email: string;
    role: string;
    status: string;
  };
  /** Roles this principal may assign. */
  assignableRoles: ReadonlyArray<{ value: string; label: string }>;
  canChangeRole: boolean;
  canRemove: boolean;
  /** Only an owner holds `org:transfer_ownership`; an admin does not. */
  canTransferOwnership: boolean;
  /** True for the signed-in person, who must not remove themselves by accident. */
  isSelf: boolean;
}

const ROLE_LABEL: Record<string, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  ACCOUNT_MANAGER: 'Account manager',
  CONTENT_CREATOR: 'Content creator',
  APPROVER: 'Approver',
  CLIENT: 'Client',
};

export function MemberRow({
  orgSlug,
  member,
  assignableRoles,
  canChangeRole,
  canRemove,
  canTransferOwnership,
  isSelf,
}: MemberRowProps) {
  const router = useRouter();
  const toast = useToast();

  const [role, setRole] = React.useState(member.role);
  const [busy, setBusy] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [handingOver, setHandingOver] = React.useState(false);
  const [typedName, setTypedName] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const base = `/api/v1/orgs/${encodeURIComponent(orgSlug)}/members/${encodeURIComponent(member.userId)}`;

  // An Owner is never editable from here, and neither is your own role — a
  // person quietly demoting themselves out of the page they are standing on is
  // a support ticket, not a feature.
  const roleEditable = canChangeRole && member.role !== 'OWNER' && !isSelf;
  const removable = canRemove && member.role !== 'OWNER' && !isSelf;

  /**
   * Offered only where it could actually succeed.
   *
   * A client is excluded here as well as in the service: `CLIENT` is the role
   * for the people an agency works *for*, and the API refuses it. Leaving the
   * button visible would make "hand over the agency" look like a thing you can
   * do to a customer.
   */
  const transferable =
    canTransferOwnership &&
    !isSelf &&
    member.role !== 'OWNER' &&
    member.role !== 'CLIENT' &&
    member.status === 'ACTIVE';

  const who = member.name ?? member.email;
  // Compared loosely: somebody typing a colleague's name should not be defeated
  // by a trailing space or a capital letter.
  const nameConfirmed = typedName.trim().toLowerCase() === who.trim().toLowerCase();

  async function changeRole(next: string) {
    const previous = role;
    setRole(next);
    setBusy(true);
    setError(null);

    try {
      await apiRequest(base, { method: 'PATCH', body: JSON.stringify({ role: next }) });
      toast.show(`${member.name ?? member.email} is now ${ROLE_LABEL[next] ?? next}.`);
      router.refresh();
    } catch (e) {
      // Put the select back where it was: leaving it showing a role the server
      // refused would be a lie about the state of the account.
      setRole(previous);
      setError(e instanceof ApiError ? e.message : 'That role could not be changed.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);

    try {
      await apiRequest(base, { method: 'DELETE' });
      toast.show(`${member.name ?? member.email} was removed.`);
      setConfirming(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'They could not be removed.');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  async function handOver() {
    setBusy(true);
    setError(null);

    try {
      await apiRequest(`/api/v1/orgs/${encodeURIComponent(orgSlug)}/transfer-ownership`, {
        method: 'POST',
        body: JSON.stringify({ userId: member.userId }),
      });
      toast.show(`${who} now owns this organization. You are an Admin.`);
      setHandingOver(false);
      setTypedName('');
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Ownership could not be transferred.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">
            {member.name ?? member.email}
            {isSelf ? <span className="ml-1.5 text-xs text-ink-muted">(you)</span> : null}
          </p>
          {member.name ? <p className="truncate text-xs text-ink-muted">{member.email}</p> : null}
          {error ? (
            <p role="alert" className="mt-1 text-xs font-medium text-danger">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {member.status !== 'ACTIVE' ? (
            <Badge tone="warning">{member.status === 'INVITED' ? 'Invited' : 'Suspended'}</Badge>
          ) : null}

          {roleEditable ? (
            <>
              <label className="sr-only" htmlFor={`role-${member.userId}`}>
                Role for {member.name ?? member.email}
              </label>
              <Select
                id={`role-${member.userId}`}
                value={role}
                disabled={busy}
                className="w-44"
                onChange={(event) => void changeRole(event.target.value)}
              >
                {assignableRoles.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </>
          ) : (
            // A client is not staff, and the list should not read as though they
            // were — the badge is the fastest way to see who is outside.
            <Badge tone={member.role === 'CLIENT' ? 'info' : 'neutral'}>
              {ROLE_LABEL[member.role] ?? member.role}
            </Badge>
          )}

          {transferable ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setTypedName('');
                setHandingOver(true);
              }}
            >
              Make owner
            </Button>
          ) : null}

          {removable ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
              Remove
            </Button>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        busy={busy}
        onClose={() => setConfirming(false)}
        onConfirm={remove}
        title={`Remove ${member.name ?? member.email}?`}
        description="They lose access to this organization immediately."
        confirmLabel="Remove"
      >
        <p className="text-sm text-ink-secondary">
          Their posts, comments and history stay — only their access goes. To bring them back you
          would invite them again and they would have to accept.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={handingOver}
        busy={busy}
        // Guarded by the typed name as well as the button: this is the one
        // action on the page that the person doing it cannot reverse.
        confirmDisabled={!nameConfirmed}
        onClose={() => {
          setHandingOver(false);
          setTypedName('');
        }}
        onConfirm={handOver}
        title={`Hand this organization to ${who}?`}
        description="They become the Owner and you become an Admin."
        confirmLabel="Hand over"
      >
        <div className="space-y-3">
          <p className="text-sm text-ink-secondary">
            As an Admin you keep everything except three things: deleting the organization,
            transferring it, and billing.{' '}
            <strong className="font-medium text-ink">You cannot undo this yourself</strong> — only{' '}
            {who} could hand it back.
          </p>

          <Field
            label={`Type “${who}” to confirm`}
            htmlFor={`handover-${member.userId}`}
            hint="So this cannot be clicked through by accident."
          >
            <Input
              id={`handover-${member.userId}`}
              value={typedName}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setTypedName(event.target.value)}
            />
          </Field>
        </div>
      </ConfirmDialog>
    </>
  );
}
