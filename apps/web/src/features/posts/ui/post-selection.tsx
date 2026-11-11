'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, ConfirmDialog, useToast } from '@orbit/ui';
import { ApiError, apiRequest } from './api';

/**
 * Choosing several posts in the list, and acting on them at once.
 *
 * The list itself stays server-rendered: each card is passed in as children of
 * a `SelectableRow`, and only the checkboxes and the action bar run in the
 * browser. Which actions appear is decided on the server from the viewer's
 * grant; the server decides again, post by post, when one is used.
 */

type Action = 'delete' | 'duplicate' | 'cancel';

interface BulkResult {
  succeeded: number;
  failed: number;
  results: Array<{ postId: string; ok: boolean; message?: string }>;
}

interface SelectionContextValue {
  selected: ReadonlySet<string>;
  toggle: (postId: string) => void;
  disabled: boolean;
}

const SelectionContext = React.createContext<SelectionContextValue | null>(null);

function useSelection(): SelectionContextValue {
  const context = React.useContext(SelectionContext);
  if (!context) throw new Error('SelectableRow must be inside PostSelection');
  return context;
}

const VERB: Record<Action, { label: string; done: string; failed: string }> = {
  delete: { label: 'Delete', done: 'Deleted', failed: 'could not be deleted' },
  duplicate: { label: 'Duplicate', done: 'Duplicated', failed: 'could not be duplicated' },
  cancel: { label: 'Cancel', done: 'Canceled', failed: 'could not be canceled' },
};

export interface PostSelectionProps {
  orgSlug: string;
  /** The posts on this page, in order, with a name to report results by. */
  posts: Array<{ id: string; title: string }>;
  /** Which actions this viewer holds anywhere. Each post is still checked on its own. */
  actions: Action[];
  children: React.ReactNode;
}

export function PostSelection({ orgSlug, posts, actions, children }: PostSelectionProps) {
  const router = useRouter();
  const toast = useToast();
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [confirming, setConfirming] = React.useState<Action | null>(null);
  const [failures, setFailures] = React.useState<string[]>([]);

  // A refresh after an action, or a new filter, changes which posts are here.
  const ids = posts.map((post) => post.id).join(',');
  React.useEffect(() => {
    setSelected((current) => {
      const present = new Set(ids.split(','));
      return new Set([...current].filter((id) => present.has(id)));
    });
  }, [ids]);

  const toggle = React.useCallback((postId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });
  }, []);

  const allSelected = posts.length > 0 && selected.size === posts.length;
  const titleOf = new Map(posts.map((post) => [post.id, post.title]));

  async function run(action: Action) {
    setBusy(true);
    setFailures([]);
    try {
      const result = await apiRequest<BulkResult>(
        `/api/v1/orgs/${encodeURIComponent(orgSlug)}/posts/bulk`,
        { method: 'POST', body: JSON.stringify({ action, postIds: [...selected] }) },
      );

      const verb = VERB[action];
      if (result.succeeded > 0) {
        toast.show(
          `${verb.done} ${result.succeeded} post${result.succeeded === 1 ? '' : 's'}.`,
          'success',
        );
      }
      // Refusals are listed by post, with the reason, and stay on screen: a
      // toast that vanishes in five seconds is the wrong place to explain why
      // three posts were not deleted.
      setFailures(
        result.results
          .filter((item) => !item.ok)
          .map(
            (item) =>
              `“${titleOf.get(item.postId) ?? 'A post'}” ${verb.failed}: ${item.message ?? 'refused.'}`,
          ),
      );
      setSelected(new Set(result.results.filter((item) => !item.ok).map((item) => item.postId)));
      router.refresh();
    } catch (error) {
      setFailures([error instanceof ApiError ? error.message : 'That could not be done.']);
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  const count = selected.size;

  return (
    <SelectionContext.Provider value={{ selected, toggle, disabled: busy }}>
      {actions.length > 0 ? (
        <div className="mt-6 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="size-4 accent-accent"
              checked={allSelected}
              disabled={busy || posts.length === 0}
              aria-label="Select every post on this page"
              onChange={() =>
                setSelected(allSelected ? new Set() : new Set(posts.map((post) => post.id)))
              }
            />
            {count > 0 ? `${count} selected` : 'Select all'}
          </label>

          {count > 0 ? (
            <div className="flex flex-wrap gap-2">
              {actions.includes('duplicate') ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void run('duplicate')}
                >
                  Duplicate
                </Button>
              ) : null}
              {actions.includes('cancel') ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setConfirming('cancel')}
                >
                  Cancel
                </Button>
              ) : null}
              {actions.includes('delete') ? (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => setConfirming('delete')}
                >
                  Delete
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setSelected(new Set())}
              >
                Clear selection
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {failures.length > 0 ? (
        <div
          role="alert"
          className="mt-3 space-y-1 rounded-lg border border-danger/40 bg-surface px-3 py-2 text-sm text-danger"
        >
          {failures.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}

      {children}

      <ConfirmDialog
        open={confirming === 'delete'}
        busy={busy}
        tone="danger"
        onClose={() => setConfirming(null)}
        onConfirm={() => run('delete')}
        title={`Delete ${count} post${count === 1 ? '' : 's'}?`}
        description="They leave the list, the calendar and every queue. A post that has already been published is kept, and stays on its platform."
        confirmLabel="Delete"
      />
      <ConfirmDialog
        open={confirming === 'cancel'}
        busy={busy}
        onClose={() => setConfirming(null)}
        onConfirm={() => run('cancel')}
        title={`Cancel ${count} post${count === 1 ? '' : 's'}?`}
        description="Scheduled posts will not go out. Cancelled posts stay in the list, marked Canceled."
        confirmLabel="Cancel posts"
        cancelLabel="Keep them"
      />
    </SelectionContext.Provider>
  );
}

/** One card with its checkbox. The card itself is rendered on the server. */
export function SelectableRow({
  postId,
  label,
  selectable,
  children,
}: {
  postId: string;
  /** What the checkbox is for, for a screen reader. */
  label: string;
  /** False when the viewer can act on nothing, so no checkbox is drawn. */
  selectable: boolean;
  children: React.ReactNode;
}) {
  const { selected, toggle, disabled } = useSelection();
  if (!selectable) return <>{children}</>;

  const checked = selected.has(postId);
  return (
    <div className="flex items-start gap-3">
      <input
        type="checkbox"
        className="mt-5 size-4 shrink-0 accent-accent"
        checked={checked}
        disabled={disabled}
        aria-label={`Select ${label}`}
        onChange={() => toggle(postId)}
      />
      <div className={checked ? 'min-w-0 flex-1 rounded-xl ring-2 ring-accent' : 'min-w-0 flex-1'}>
        {children}
      </div>
    </div>
  );
}
