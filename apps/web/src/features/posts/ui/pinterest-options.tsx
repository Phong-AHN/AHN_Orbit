'use client';

import * as React from 'react';
import { Alert, Badge, Button, Field, Select, Spinner } from '@orbit/ui';
import { ApiError, apiRequest } from './api';

/**
 * Pinterest's per-post settings (SRS §7).
 *
 * **A pin has to be filed somewhere.** Pinterest offers no default board, and
 * picking one on a client's behalf would file their content wherever happened
 * to come back first — an editorial decision made by a machine. So the list is
 * read from the account itself and nothing is preselected; the adapter refuses
 * to publish until a board is chosen.
 *
 * The list comes from Pinterest rather than from a cache: boards are created
 * and deleted constantly, and a stale list's failure mode is offering a board
 * that no longer exists, which surfaces as a publish failure long after the
 * choice was made.
 *
 * Secret boards never appear. Orbit does not ask for the scope that would
 * return them.
 */

export interface PinterestOptions {
  boardId?: string;
}

interface Board {
  id: string;
  name: string;
  privacy: string;
}

export interface PinterestOptionsProps {
  orgSlug: string;
  socialAccountId: string;
  accountName: string;
  /** What the server currently holds for this variant. */
  saved: PinterestOptions;
  disabled: boolean;
  /** Persist. Resolves once the server has confirmed. */
  onSave: (next: PinterestOptions) => Promise<void>;
}

export function PinterestOptionsPanel({
  orgSlug,
  socialAccountId,
  accountName,
  saved,
  disabled,
  onSave,
}: PinterestOptionsProps) {
  const [boards, setBoards] = React.useState<Board[] | null>(null);
  const [loading, setLoading] = React.useState(true);

  /**
   * Two failures, two states, on purpose: failing to *read* the boards means no
   * choice can be offered, while failing to *save* means the controls are fine
   * and the write did not land. Sharing one state makes a failed save replace
   * the panel with a sentence about a call that succeeded.
   */
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const [value, setValue] = React.useState<PinterestOptions>(saved);
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);

  // Keyed on contents, not the object reference — see the note in
  // `youtube-options.tsx`; the parent rebuilds `saved` on every render.
  const savedKey = JSON.stringify(saved);

  React.useEffect(() => {
    setValue(JSON.parse(savedKey) as PinterestOptions);
    setSavedAt(null);
  }, [savedKey]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    apiRequest<{ boards: Board[] }>(
      `/api/v1/orgs/${encodeURIComponent(orgSlug)}/social-accounts/${encodeURIComponent(socialAccountId)}/pinterest-boards`,
    )
      .then((result) => {
        if (!cancelled) setBoards(result.boards);
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setLoadError(
          failure instanceof ApiError
            ? failure.message
            : 'This account’s boards could not be read.',
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [orgSlug, socialAccountId]);

  const dirty = (value.boardId ?? '') !== (saved.boardId ?? '');

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(value);
      setSavedAt(Date.now());
    } catch (failure) {
      setSaveError(
        failure instanceof ApiError ? failure.message : 'Those settings could not be saved.',
      );
    } finally {
      setSaving(false);
    }
  }

  /**
   * A stored board can disappear. Naming it here beats a publish failure hours
   * later that says only "board not found".
   */
  const missingBoard =
    Boolean(value.boardId) && boards !== null && !boards.some((b) => b.id === value.boardId);

  return (
    <div className="space-y-3 rounded-lg border border-line bg-surface-sunken p-3">
      <p className="flex items-center gap-2 text-sm font-medium text-ink">
        Pinterest settings
        <Badge tone="neutral">{accountName}</Badge>
      </p>

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-ink-muted">
          <Spinner className="size-4" /> Reading this account&rsquo;s boards&hellip;
        </p>
      ) : loadError ? (
        <Alert tone="warning" title="This account&rsquo;s boards could not be read">
          {loadError} A pin has to go on a board, so this post cannot be published until they can be
          read.
        </Alert>
      ) : boards && boards.length === 0 ? (
        <Alert tone="warning" title="This account has no boards">
          A pin has to be filed on a board. Create one in Pinterest, then reopen this post.
        </Alert>
      ) : boards ? (
        <>
          <Field
            label="Board"
            htmlFor={`pinterest-board-${socialAccountId}`}
            hint="Secret boards are not listed — Orbit does not have access to them."
          >
            <Select
              id={`pinterest-board-${socialAccountId}`}
              value={value.boardId ?? ''}
              disabled={disabled || saving}
              onChange={(event) => {
                // The placeholder means "not chosen". An empty string is not a
                // board id and the server would reject it with a 400 that says
                // nothing useful; dropping the key is what unset looks like.
                const { boardId: _dropped, ...rest } = value;
                setValue(event.target.value ? { ...rest, boardId: event.target.value } : rest);
                setSavedAt(null);
              }}
            >
              <option value="">Choose&hellip;</option>
              {boards.map((board) => (
                <option key={board.id} value={board.id}>
                  {board.name}
                  {board.privacy && board.privacy !== 'PUBLIC' ? ` (${board.privacy})` : ''}
                </option>
              ))}
            </Select>
          </Field>

          {missingBoard ? (
            <Alert tone="warning" title="That board is no longer there">
              The board this pin was filed on has been deleted or is no longer visible to Orbit.
              Pick another one.
            </Alert>
          ) : null}

          {!value.boardId ? (
            <p className="text-xs text-warning">
              Until a board is chosen, the post will not publish — Pinterest has no default and
              Orbit will not pick one for you.
            </p>
          ) : null}

          {/* Said before the choice, not after the failure: a video pin with no
              cover image is refused at publish time, which is hours too late. */}
          <p className="text-xs text-ink-muted">
            A video pin also needs a cover image. Attach one alongside the video — Pinterest shows
            it wherever the video is not playing.
          </p>
        </>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button
          size="sm"
          variant="secondary"
          loading={saving}
          disabled={disabled || saving || !dirty}
          onClick={() => void save()}
        >
          Save Pinterest settings
        </Button>

        {dirty ? (
          <span className="text-xs text-warning">Not saved yet</span>
        ) : savedAt ? (
          <span className="text-xs text-ink-muted">Saved</span>
        ) : null}
      </div>

      {saveError ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {saveError}
        </p>
      ) : null}
    </div>
  );
}
