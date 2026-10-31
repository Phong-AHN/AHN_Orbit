'use client';

import * as React from 'react';
import { Alert, Badge, Button, Field, Input, Select, Spinner } from '@orbit/ui';
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
 *
 * **Sandbox mode** is the exception. Production boards are not visible in
 * Pinterest's sandbox, so the panel offers to create a secret test board —
 * the only place Social Square ever creates one.
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
  const [sandbox, setSandbox] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  const [boardName, setBoardName] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);

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

    apiRequest<{ boards: Board[]; sandbox: boolean }>(boardsUrl(orgSlug, socialAccountId))
      .then((result) => {
        if (cancelled) return;
        setBoards(result.boards);
        setSandbox(result.sandbox === true);
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

  async function createBoard() {
    const name = boardName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    try {
      const { board } = await apiRequest<{ board: Board }>(boardsUrl(orgSlug, socialAccountId), {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      setBoards((current) => [...(current ?? []), board]);
      setBoardName('');

      // Chosen *and* saved. Creating a board for this pin is an unambiguous
      // choice, and leaving a separate Save step after it sent posts out with
      // the board showing as selected but never stored.
      const next = { ...value, boardId: board.id };
      setValue(next);
      setSavedAt(null);
      setSaveError(null);
      try {
        await onSave(next);
        setSavedAt(Date.now());
      } catch (failure) {
        setSaveError(
          failure instanceof ApiError ? failure.message : 'That board could not be saved.',
        );
      }
    } catch (failure) {
      setCreateError(
        failure instanceof ApiError ? failure.message : 'The board could not be created.',
      );
    } finally {
      setCreating(false);
    }
  }

  const createForm = sandbox ? (
    <div className="space-y-2">
      <Field
        label="New private test board"
        htmlFor={`pinterest-new-board-${socialAccountId}`}
        hint="Created as a secret board in Pinterest’s sandbox and saved as this pin’s board."
      >
        <div className="flex gap-2">
          <Input
            id={`pinterest-new-board-${socialAccountId}`}
            value={boardName}
            maxLength={50}
            placeholder="Social Square test"
            disabled={disabled || creating}
            onChange={(event) => setBoardName(event.target.value)}
          />
          <Button
            size="sm"
            variant="secondary"
            loading={creating}
            disabled={disabled || creating || !boardName.trim()}
            onClick={() => void createBoard()}
          >
            Create board
          </Button>
        </div>
      </Field>
      {createError ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {createError}
        </p>
      ) : null}
    </div>
  ) : null;

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
        {sandbox ? <Badge tone="warning">Sandbox</Badge> : null}
      </p>

      {sandbox ? (
        <p className="text-xs text-ink-muted">
          Pinterest sandbox mode: pins go to Pinterest&rsquo;s sandbox and are visible only to this
          account. Video pins are not supported there.
        </p>
      ) : null}

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-ink-muted">
          <Spinner className="size-4" /> Reading this account&rsquo;s boards&hellip;
        </p>
      ) : loadError ? (
        <Alert tone="warning" title="This account&rsquo;s boards could not be read">
          {loadError} A pin has to go on a board, so this post cannot be published until they can be
          read.
        </Alert>
      ) : boards && boards.length === 0 && !sandbox ? (
        <Alert tone="warning" title="This account has no boards">
          A pin has to be filed on a board. Create one in Pinterest, then reopen this post.
        </Alert>
      ) : boards && boards.length === 0 ? (
        createForm
      ) : boards ? (
        <>
          <Field
            label="Board"
            htmlFor={`pinterest-board-${socialAccountId}`}
            hint={
              sandbox
                ? 'Sandbox boards only — production boards are not visible here.'
                : 'Secret boards are not listed — Social Square does not have access to them.'
            }
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

          {createForm}

          {missingBoard ? (
            <Alert tone="warning" title="That board is no longer there">
              The board this pin was filed on has been deleted or is no longer visible to Social
              Square. Pick another one.
            </Alert>
          ) : null}

          {!value.boardId ? (
            <p className="text-xs text-warning">
              Until a board is chosen, the post will not publish — Pinterest has no default and
              Social Square will not pick one for you.
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

function boardsUrl(orgSlug: string, socialAccountId: string): string {
  return `/api/v1/orgs/${encodeURIComponent(orgSlug)}/social-accounts/${encodeURIComponent(socialAccountId)}/pinterest-boards`;
}
