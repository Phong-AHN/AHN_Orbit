'use client';

import * as React from 'react';
import { splitManualThread, withoutThreadMarker } from '@orbit/providers/thread';
import { Badge, Button, Textarea, cn } from '@orbit/ui';

/**
 * A thread's posts, shown and edited one by one (D-124).
 *
 * Shows what the server says the account will publish — the split comes from
 * `/validate`, never from a guess here. "Edit posts" turns each into a box of
 * its own; saving stores them in the account's own text, separated by `---`
 * lines, and marks the thread as edited by hand. From then on each post goes
 * out as written (plus its place, if numbered) instead of being split again.
 *
 * Counts here are a hint, by plain length: the platform's own counting (X's
 * weights, Bluesky's graphemes) is applied by `/validate`, which names any post
 * that is too long.
 */
export interface ThreadEditorProps {
  /** The posts as the server split them, markers included. Absent for one post. */
  parts: readonly string[] | undefined;
  /** Edited by hand: `body` holds the posts. */
  manual: boolean;
  /** The account's own text. */
  body: string;
  maxTextLength: number;
  maxPosts: number | null;
  numbered: boolean;
  readOnly: boolean;
  onSave: (parts: string[]) => Promise<void>;
  onReset: () => Promise<void>;
}

export function ThreadEditor({
  parts,
  manual,
  body,
  maxTextLength,
  maxPosts,
  numbered,
  readOnly,
  onSave,
  onReset,
}: ThreadEditorProps) {
  const [editing, setEditing] = React.useState<string[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const shown = parts ?? (manual ? splitManualThread(body) : undefined);
  if (!shown || (shown.length < 2 && !manual)) return null;

  function startEditing() {
    setError(null);
    setEditing(manual ? splitManualThread(body) : (shown ?? []).map(withoutThreadMarker));
  }

  async function run(action: () => Promise<void>, failure: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : failure);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    const filled = editing.filter((part) => part.trim().length > 0);
    const canAdd = maxPosts === null || editing.length < maxPosts;

    return (
      <div className="space-y-3 rounded-lg border border-line bg-surface-sunken p-3">
        <p className="text-xs text-ink-muted">
          Each box is one post. Move text between them as you like; empty boxes are dropped.
          {numbered ? ' The place (1/3, 2/3…) is added when it is published.' : ''}
        </p>

        <ol className="space-y-3">
          {editing.map((part, index) => {
            const marker = numbered && editing.length > 1 ? ` ${index + 1}/${editing.length}` : '';
            const length = [...part.trim()].length + marker.length;
            return (
              <li key={index} className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor={`thread-part-${index}`} className="text-xs font-medium text-ink">
                    Post {index + 1} of {editing.length}
                  </label>
                  <span
                    className={cn(
                      'font-mono text-xs',
                      length > maxTextLength ? 'font-semibold text-danger' : 'text-ink-muted',
                    )}
                  >
                    {length.toLocaleString()}/{maxTextLength.toLocaleString()}
                  </span>
                </div>
                <Textarea
                  id={`thread-part-${index}`}
                  rows={4}
                  value={part}
                  disabled={busy}
                  onChange={(event) => {
                    const next = [...editing];
                    next[index] = event.target.value;
                    setEditing(next);
                  }}
                />
                {editing.length > 1 ? (
                  <button
                    type="button"
                    className="text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline"
                    disabled={busy}
                    onClick={() => {
                      setEditing(editing.filter((_, at) => at !== index));
                    }}
                  >
                    Remove this post
                  </button>
                ) : null}
              </li>
            );
          })}
        </ol>

        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            loading={busy}
            disabled={filled.length === 0}
            onClick={() => {
              void run(() => onSave(filled), 'The posts could not be saved.');
            }}
          >
            Save posts
          </Button>
          {canAdd ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setEditing([...editing, '']);
              }}
            >
              Add a post
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setEditing(null);
              setError(null);
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line bg-surface-sunken p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="text-xs font-medium text-ink-muted">
          Publishes as {shown.length} {shown.length === 1 ? 'post' : 'posts'} — as last saved
        </p>
        {manual ? <Badge tone="neutral">Edited by hand</Badge> : null}
      </div>

      <ol className="space-y-2">
        {shown.map((part, index) => (
          <li
            key={index}
            className="whitespace-pre-wrap rounded-md border border-line bg-surface p-2.5 text-sm text-ink"
          >
            {part}
          </li>
        ))}
      </ol>

      {error ? (
        <p role="alert" className="mt-2 text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}

      {!readOnly ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={startEditing}>
            Edit posts
          </Button>
          {manual ? (
            <Button
              size="sm"
              variant="ghost"
              loading={busy}
              onClick={() => {
                void run(onReset, 'The thread could not be reset.');
              }}
            >
              Split automatically again
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
