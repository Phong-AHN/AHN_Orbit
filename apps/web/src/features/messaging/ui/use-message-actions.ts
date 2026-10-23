'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * The three things somebody does to a conversation (**D-107**).
 *
 * Shaped like `useCommentActions`, and for the same reasons: a reply is never
 * optimistic — busy until the platform has confirmed it, and the draft kept on
 * any failure — and the server is asked again afterwards rather than a local
 * copy patched.
 */
export function useMessageActions(orgSlug: string, conversationId: string) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const base = `/api/v1/orgs/${encodeURIComponent(orgSlug)}/messages/${conversationId}`;

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
    reply: (text: string) => act('reply', { text }, 'Message sent.'),
    setHandled: (handled: boolean) =>
      act('handled', { handled }, handled ? 'Marked handled.' : 'Back in the inbox.'),
    assign: (assignedToId: string | null) =>
      act('assign', { assignedToId }, assignedToId ? 'Assigned.' : 'Unassigned.'),
  };
}
