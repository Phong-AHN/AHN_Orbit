'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, ConfirmDialog, useToast } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * Invitations sent and not yet accepted (SRS §5).
 *
 * These were invisible: an invitation created, the link copied and then lost,
 * left no trace anybody could see — so the only recovery was to send another
 * one and hope the first was never used. Showing them makes the state
 * observable, and withdrawing one makes it recoverable.
 *
 * **There is no "resend".** The token exists only in the link that was shown
 * once; only its hash is stored, so nothing on the server can reproduce it
 * (**D-034**). Withdrawing and inviting again is the honest equivalent, and it
 * is what the buttons say.
 */

export interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
}

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Admin',
  ACCOUNT_MANAGER: 'Account manager',
  CONTENT_CREATOR: 'Content creator',
  APPROVER: 'Approver',
  CLIENT: 'Client',
};

export function PendingInvitations({
  orgSlug,
  invitations,
  canRevoke,
}: {
  orgSlug: string;
  invitations: PendingInvitation[];
  canRevoke: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  const [revoking, setRevoking] = React.useState<PendingInvitation | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (invitations.length === 0) return null;

  async function revoke(invitation: PendingInvitation) {
    setBusy(true);
    setError(null);

    try {
      await apiRequest(
        `/api/v1/orgs/${encodeURIComponent(orgSlug)}/invitations/${encodeURIComponent(invitation.id)}`,
        { method: 'DELETE' },
      );

      toast.show(`The invitation to ${invitation.email} was withdrawn.`);
      setRevoking(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That invitation could not be withdrawn.');
      setRevoking(null);
    } finally {
      setBusy(false);
    }
  }

  const now = Date.now();

  return (
    <>
      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}

      <ul className="space-y-2">
        {invitations.map((invitation) => {
          const expired = new Date(invitation.expiresAt).getTime() <= now;

          return (
            <li
              key={invitation.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-dashed border-line px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-ink">{invitation.email}</p>
                <p className="text-xs text-ink-muted">
                  {expired
                    ? 'Expired — withdraw it and invite them again.'
                    : `Expires ${invitation.expiresAt.slice(0, 10)}`}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <Badge tone={expired ? 'danger' : 'warning'}>
                  {expired ? 'Expired' : 'Awaiting acceptance'}
                </Badge>
                <Badge tone="neutral">{ROLE_LABEL[invitation.role] ?? invitation.role}</Badge>

                {canRevoke ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setRevoking(invitation)}
                  >
                    Withdraw
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={revoking !== null}
        busy={busy}
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          if (revoking) await revoke(revoking);
        }}
        title="Withdraw this invitation?"
        description={
          revoking ? `The link sent to ${revoking.email} stops working immediately.` : ''
        }
        confirmLabel="Withdraw"
      >
        <p className="text-sm text-ink-secondary">
          If they have already opened it and joined, this does nothing — withdrawing only affects an
          invitation nobody has accepted.
        </p>
      </ConfirmDialog>
    </>
  );
}
