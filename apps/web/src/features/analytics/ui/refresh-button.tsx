'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, useToast } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * "Refresh figures": read Page and post figures now (D-122).
 *
 * The server queues the reads and the worker makes them, so nothing is
 * known when this returns except how much was queued. The page re-reads
 * itself a little later to pick up what has arrived; Meta itself reports
 * Page insights up to a day late, which the message says rather than
 * promising numbers the platform has not produced yet.
 */
export function RefreshAnalyticsButton({
  orgSlug,
  workspaceId,
  accountId,
}: {
  orgSlug: string;
  workspaceId?: string | undefined;
  accountId?: string | undefined;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);

  async function refresh() {
    setBusy(true);
    try {
      const queued = await apiRequest<{ accounts: number; posts: number }>(
        `/api/v1/orgs/${encodeURIComponent(orgSlug)}/analytics/refresh`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...(workspaceId ? { workspaceId } : {}),
            ...(accountId ? { accountId } : {}),
          }),
        },
      );
      toast.show(
        `Reading ${queued.accounts} account${queued.accounts === 1 ? '' : 's'} and ${queued.posts} post${
          queued.posts === 1 ? '' : 's'
        }. Figures update within a minute or two; Meta can report Page insights up to a day late.`,
        'success',
      );
      window.setTimeout(() => router.refresh(), 30_000);
    } catch (error) {
      toast.show(error instanceof ApiError ? error.message : 'That did not work.', 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button size="sm" variant="secondary" loading={busy} onClick={() => void refresh()}>
      Refresh figures
    </Button>
  );
}
