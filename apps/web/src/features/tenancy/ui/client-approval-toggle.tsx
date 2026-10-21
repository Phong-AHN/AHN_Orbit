'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ConfirmDialog, useToast } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * Whether a workspace has a client who approves its posts (**D-106**).
 *
 * The two directions are deliberately unalike. **Turning the client off** asks
 * first, because of what it unlocks: from then on a post's own author may
 * approve and schedule it, and nobody outside the agency sees it before it
 * goes out. **Turning the client back on** just saves — it only adds a review,
 * and a confirmation for the safe direction would be noise.
 *
 * Rendered only for people who may change it (Owner and Admin); the API
 * refuses everybody else, including an Account Manager who may otherwise edit
 * this workspace.
 */
export function ClientApprovalToggle({
  orgSlug,
  workspaceId,
  workspaceName,
  requiresClientApproval,
}: {
  orgSlug: string;
  workspaceId: string;
  workspaceName: string;
  requiresClientApproval: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  const [busy, setBusy] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const id = `client-approval-${workspaceId}`;

  async function save(next: boolean) {
    setBusy(true);
    setError(null);

    try {
      await apiRequest(
        `/api/v1/orgs/${encodeURIComponent(orgSlug)}/workspaces/${encodeURIComponent(workspaceId)}`,
        { method: 'PATCH', body: JSON.stringify({ requiresClientApproval: next }) },
      );
      toast.show(
        next
          ? `${workspaceName} posts now go to the client for approval.`
          : `${workspaceName} is internal — authors can approve and schedule their own posts.`,
      );
      setConfirming(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That setting could not be changed.');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2.5">
      <label htmlFor={id} className="flex items-start gap-2.5 text-sm">
        <input
          id={id}
          type="checkbox"
          className="mt-0.5 size-4 accent-accent"
          checked={requiresClientApproval}
          disabled={busy}
          onChange={(e) => {
            if (e.target.checked) void save(true);
            else setConfirming(true);
          }}
        />
        <span>
          <span className="font-medium text-ink">Client approves posts</span>
          <span className="block text-xs text-ink-muted">
            {requiresClientApproval
              ? 'Posts go to the client after internal review.'
              : 'Internal workspace — no client review. A post’s author may approve and schedule it themselves.'}
          </span>
        </span>
      </label>
      {error ? (
        <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirming}
        busy={busy}
        onClose={() => setConfirming(false)}
        onConfirm={() => save(false)}
        title={`Make ${workspaceName} internal?`}
        description="Posts here will no longer go to a client for approval."
        confirmLabel="Make internal"
      >
        <div className="space-y-2 text-sm text-ink-secondary">
          <p>
            The author of a post may approve and schedule it themselves, without anyone else
            reviewing it. Use this for the agency&rsquo;s own accounts, not a client&rsquo;s.
          </p>
          <p>
            Posts already waiting for the client stay with the client. You can turn client approval
            back on at any time; posts approved in the meantime stay approved.
          </p>
        </div>
      </ConfirmDialog>
    </div>
  );
}
