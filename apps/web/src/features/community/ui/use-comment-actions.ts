'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * The three things somebody does to a comment, shared by every screen that
 * shows one.
 *
 * Lifted out of the original `CommentRow` when the inbox moved to a thread per
 * post, and that component was removed rather than kept alongside it.
 * Two copies of "post a reply" is exactly how one of them ends up optimistic
 * and the other not — and a reply is the one action here that reaches a
 * client's channel in public, under their name.
 *
 * ## Replying is never optimistic
 *
 * The busy state holds until the server confirms the platform accepted the
 * reply, and the draft is kept on any failure. Clearing a composer on a failed
 * send is how somebody loses a carefully worded answer and then cannot tell
 * whether it went out.
 *
 * ## The server is asked again rather than patched locally
 *
 * State, assignment and whether a reply now exists are all server-rendered, so
 * `router.refresh()` re-reads them. There is no client copy to drift.
 */
export function useCommentActions(orgSlug: string, commentId: string) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const base = `/api/v1/orgs/${encodeURIComponent(orgSlug)}/community/${commentId}`;

  const act = React.useCallback(
    async (path: string, body: unknown, done: string): Promise<boolean> => {
      setBusy(true);
      setError(null);

      try {
        await apiRequest(`${base}/${path}`, { method: 'POST', body: JSON.stringify(body) });
        toast.show(done);
        router.refresh();
        return true;
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'That did not work.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [base, router, toast],
  );

  return {
    busy,
    error,
    reply: (message: string) => act('reply', { message }, 'Reply posted.'),
    setHandled: (handled: boolean) =>
      act('handled', { handled }, handled ? 'Marked handled.' : 'Back in the queue.'),
    assign: (assignedToId: string | null) =>
      act('assign', { assignedToId }, assignedToId ? 'Assigned.' : 'Unassigned.'),
  };
}
