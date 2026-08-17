'use client';

import * as React from 'react';
import { Button } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';
import { ActivityList, type ActivityEntry } from './activity-list';

/**
 * The activity feed, with the rest of it (SRS §41).
 *
 * The service has always returned a `nextCursor` and nothing consumed it, so
 * the trail stopped at fifty entries — which is a few busy days for one agency,
 * and made the log useless for the question it exists to answer ("what happened
 * in March").
 *
 * **Load more, not infinite scroll.** An audit trail is something people read
 * deliberately, often looking for one event; a list that grows as you scroll
 * makes it impossible to reach the bottom of a filter and hard to keep your
 * place. A button also costs nothing when nobody presses it.
 */

export interface ActivityFeedProps {
  orgSlug: string;
  initial: ActivityEntry[];
  initialCursor: string | null;
  /** Narrows to one resource, for a per-object history. */
  resourceId?: string | undefined;
  workspaceId?: string | undefined;
}

export function ActivityFeed({
  orgSlug,
  initial,
  initialCursor,
  resourceId,
  workspaceId,
}: ActivityFeedProps) {
  const [entries, setEntries] = React.useState(initial);
  const [cursor, setCursor] = React.useState(initialCursor);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function loadMore() {
    if (!cursor) return;

    setBusy(true);
    setError(null);

    try {
      const params = new URLSearchParams({ before: cursor });
      if (resourceId) params.set('resourceId', resourceId);
      if (workspaceId) params.set('workspaceId', workspaceId);

      const data = await apiRequest<{ entries: ActivityEntry[]; nextCursor: string | null }>(
        `/api/v1/orgs/${encodeURIComponent(orgSlug)}/activity?${params.toString()}`,
      );

      // Appended rather than replaced, and keyed by id — a keyset page cannot
      // repeat a row, but a double click could still fire two requests.
      setEntries((current) => {
        const seen = new Set(current.map((entry) => entry.id));
        return [...current, ...data.entries.filter((entry) => !seen.has(entry.id))];
      });
      setCursor(data.nextCursor);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'More history could not be loaded.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <ActivityList entries={entries} />

      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}

      {cursor ? (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            disabled={busy}
            onClick={() => void loadMore()}
          >
            Load more
          </Button>
        </div>
      ) : (
        <p className="text-center text-xs text-ink-muted">
          {entries.length > 0 ? 'That is the whole trail.' : null}
        </p>
      )}
    </div>
  );
}
