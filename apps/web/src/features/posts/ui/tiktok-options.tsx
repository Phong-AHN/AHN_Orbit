'use client';

import * as React from 'react';
import { Alert, Badge, Button, Field, Select, Spinner } from '@orbit/ui';
import { ApiError, apiRequest } from './api';

/**
 * TikTok's per-post settings (SRS §7).
 *
 * **The options are the creator's, not ours.** TikTok requires that a direct
 * post carry a visibility chosen from what `creator_info/query` returns for
 * that account, and treats ignoring it as a Terms of Service violation rather
 * than a bad request. So this component has no hard-coded list: it asks, and
 * shows exactly what comes back. A creator who switches to a private account
 * loses the public option here the moment they do.
 *
 * That is also why there is no default. An unset visibility blocks publishing
 * with a clear message, which is the honest outcome — quietly picking
 * `SELF_ONLY` would publish to nobody, and quietly picking public would post
 * something a client never agreed to.
 *
 * **Saved on an explicit button, not on every change.** These settings are a
 * set, not five independent switches: a visibility without a post mode is
 * incomplete, and saving each control as it moves fires a request per click
 * while leaving the panel briefly disabled — which reads as the choice not
 * having registered. One save, one confirmation, one place for an error to
 * appear.
 */

export type PostMode = 'DIRECT_POST' | 'MEDIA_UPLOAD';

export interface TikTokOptions {
  postMode?: PostMode;
  privacyLevel?: string;
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
}

interface CreatorOptions {
  username: string;
  nickname: string;
  privacyLevels: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoSeconds: number;
}

/** TikTok's own wording, so what somebody picks matches what they will see. */
const PRIVACY_LABEL: Record<string, string> = {
  PUBLIC_TO_EVERYONE: 'Everyone',
  MUTUAL_FOLLOW_FRIENDS: 'Friends (mutual follows)',
  FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only this account',
};

export interface TikTokOptionsProps {
  orgSlug: string;
  socialAccountId: string;
  accountName: string;
  /** What the server currently holds for this variant. */
  saved: TikTokOptions;
  disabled: boolean;
  /** Persist. Resolves once the server has confirmed. */
  onSave: (next: TikTokOptions) => Promise<void>;
}

export function TikTokOptionsPanel({
  orgSlug,
  socialAccountId,
  accountName,
  saved,
  disabled,
  onSave,
}: TikTokOptionsProps) {
  const [creator, setCreator] = React.useState<CreatorOptions | null>(null);
  const [loading, setLoading] = React.useState(true);

  /**
   * Two failures, two states, on purpose.
   *
   * They are not interchangeable: failing to *read* TikTok's options means the
   * controls cannot be offered at all, while failing to *save* means the
   * controls are fine and the write did not land. Sharing one state made a
   * failed save replace the whole panel with "TikTok's options could not be
   * read" — a sentence about a call that had succeeded.
   */
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const [value, setValue] = React.useState<TikTokOptions>(saved);
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);

  /**
   * Follow the server when it changes underneath — a different account tab, or
   * a value written elsewhere.
   *
   * Keyed on the *contents*, not the object. The parent builds `saved` from
   * `platformOptions ?? {}`, which is a fresh object on every render, so
   * depending on the reference would re-run this effect constantly and wipe a
   * half-made selection the instant anything else on the page re-rendered —
   * which looks exactly like the setting refusing to stick.
   */
  const savedKey = JSON.stringify(saved);

  React.useEffect(() => {
    setValue(JSON.parse(savedKey) as TikTokOptions);
    setSavedAt(null);
  }, [savedKey]);

  const onChange = (next: TikTokOptions) => {
    setValue(next);
    setSavedAt(null);
  };

  // Compared field by field rather than by serialising both: key order differs
  // between what the server returns and what this component builds, and a
  // string comparison would report every panel as unsaved on first render.
  const dirty =
    (value.postMode ?? 'DIRECT_POST') !== (saved.postMode ?? 'DIRECT_POST') ||
    (value.privacyLevel ?? '') !== (saved.privacyLevel ?? '') ||
    Boolean(value.disableComment) !== Boolean(saved.disableComment) ||
    Boolean(value.disableDuet) !== Boolean(saved.disableDuet) ||
    Boolean(value.disableStitch) !== Boolean(saved.disableStitch);

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

  const mode: PostMode = value.postMode ?? 'DIRECT_POST';

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    apiRequest<CreatorOptions>(
      `/api/v1/orgs/${encodeURIComponent(orgSlug)}/social-accounts/${encodeURIComponent(socialAccountId)}/tiktok-creator`,
    )
      .then((result) => {
        if (!cancelled) setCreator(result);
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setLoadError(
          failure instanceof ApiError
            ? failure.message
            : "TikTok's posting options could not be read.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [orgSlug, socialAccountId]);

  return (
    <div className="space-y-3 rounded-lg border border-line bg-surface-sunken p-3">
      <p className="flex items-center gap-2 text-sm font-medium text-ink">
        TikTok settings
        <Badge tone="neutral">{accountName}</Badge>
      </p>

      <Field
        label="How this posts"
        htmlFor={`tiktok-mode-${socialAccountId}`}
        hint={
          mode === 'DIRECT_POST'
            ? 'Goes straight to the account at the scheduled time.'
            : 'Sends a TikTok notification. The post goes live only when someone finishes it in the TikTok app.'
        }
      >
        <Select
          id={`tiktok-mode-${socialAccountId}`}
          value={mode}
          disabled={disabled || saving}
          onChange={(event) => onChange({ ...value, postMode: event.target.value as PostMode })}
        >
          <option value="DIRECT_POST">Post it</option>
          <option value="MEDIA_UPLOAD">Send to TikTok for them to finish</option>
        </Select>
      </Field>

      {/* Upload mode carries no caption and no visibility — the creator writes
          both in TikTok's editor — so showing those controls would promise
          something that is not sent. */}
      {mode === 'MEDIA_UPLOAD' ? (
        <Alert tone="info" title="Nothing goes live on its own">
          The video lands in this account&rsquo;s TikTok inbox with the caption and visibility left
          to them. If nobody opens the notification, nothing is posted.
        </Alert>
      ) : loading ? (
        <p className="flex items-center gap-2 text-sm text-ink-muted">
          <Spinner className="size-4" /> Reading this account&rsquo;s options&hellip;
        </p>
      ) : loadError ? (
        <Alert tone="warning" title="TikTok&rsquo;s options could not be read">
          {loadError} Visibility has to come from TikTok, so this post cannot be published until it
          can be read.
        </Alert>
      ) : creator ? (
        <>
          <Field
            label="Who can see this"
            htmlFor={`tiktok-privacy-${socialAccountId}`}
            hint="These are the options this TikTok account currently allows."
          >
            <Select
              id={`tiktok-privacy-${socialAccountId}`}
              value={value.privacyLevel ?? ''}
              disabled={disabled || saving}
              onChange={(event) => {
                // The placeholder means "not chosen", and an empty string is
                // not a privacy level the server will accept — it fails the
                // enum with a 400 that says nothing useful. Dropping the key is
                // what "unset" actually looks like.
                const { privacyLevel: _dropped, ...rest } = value;
                onChange(event.target.value ? { ...rest, privacyLevel: event.target.value } : rest);
              }}
            >
              <option value="">Choose&hellip;</option>
              {creator.privacyLevels.map((level) => (
                <option key={level} value={level}>
                  {PRIVACY_LABEL[level] ?? level}
                </option>
              ))}
            </Select>
          </Field>

          {/* Said before the choice, not after the failure.

              Until TikTok audits the app, it refuses anything but "Only this
              account" — and it refuses it at publish time, hours after the
              choice was made and long after anyone is still looking. Naming the
              constraint here costs one line and saves a failed post. */}
          {value.privacyLevel && value.privacyLevel !== 'SELF_ONLY' ? (
            <p className="text-xs text-ink-muted">
              If this app is still in TikTok&rsquo;s sandbox or awaiting audit, only{' '}
              <strong className="font-medium">Only this account</strong> will publish — anything
              else is refused when the post goes out.
            </p>
          ) : null}

          {/* A stored choice can go stale: a creator who switches to a private
              account loses the public option, and TikTok would refuse the post
              rather than quietly downgrade it. */}
          {value.privacyLevel && !creator.privacyLevels.includes(value.privacyLevel) ? (
            <Alert tone="warning" title="That visibility is no longer offered">
              This account no longer allows{' '}
              {PRIVACY_LABEL[value.privacyLevel] ?? value.privacyLevel}. Pick one of its current
              options.
            </Alert>
          ) : null}

          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              Interactions
            </legend>

            <Interaction
              id={`tiktok-comment-${socialAccountId}`}
              label="Allow comments"
              // Off at the account level means it cannot be turned on here —
              // TikTok refuses the post rather than ignoring the field.
              lockedOff={creator.commentDisabled}
              checked={!creator.commentDisabled && value.disableComment !== true}
              disabled={disabled || saving}
              onChange={(allow) => onChange({ ...value, disableComment: !allow })}
            />
            <Interaction
              id={`tiktok-duet-${socialAccountId}`}
              label="Allow duets"
              lockedOff={creator.duetDisabled}
              checked={!creator.duetDisabled && value.disableDuet !== true}
              disabled={disabled || saving}
              onChange={(allow) => onChange({ ...value, disableDuet: !allow })}
            />
            <Interaction
              id={`tiktok-stitch-${socialAccountId}`}
              label="Allow stitches"
              lockedOff={creator.stitchDisabled}
              checked={!creator.stitchDisabled && value.disableStitch !== true}
              disabled={disabled || saving}
              onChange={(allow) => onChange({ ...value, disableStitch: !allow })}
            />
          </fieldset>

          {creator.maxVideoSeconds > 0 ? (
            <p className="text-xs text-ink-muted">
              This account can post videos up to {creator.maxVideoSeconds} seconds.
            </p>
          ) : null}
        </>
      ) : null}

      {/* Shown in upload mode too: the post mode is itself a setting, and
          switching to it has to be saved like anything else. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button
          size="sm"
          variant="secondary"
          loading={saving}
          disabled={disabled || saving || !dirty}
          onClick={() => void save()}
        >
          Save TikTok settings
        </Button>

        {/* Three states, and they are genuinely different: nothing to save,
            changes waiting, saved. A button that always looks the same leaves
            somebody guessing whether their choice took. */}
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

/**
 * One interaction toggle.
 *
 * `lockedOff` is not the same as `disabled`: the control is unavailable because
 * the *creator* turned it off on TikTok, and saying so is more useful than a
 * greyed-out box with no explanation.
 */
function Interaction({
  id,
  label,
  lockedOff,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  lockedOff: boolean;
  checked: boolean;
  disabled: boolean;
  onChange: (allow: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm text-ink">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled || lockedOff}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 rounded border-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      />
      <span className={lockedOff ? 'text-ink-muted' : undefined}>{label}</span>
      {lockedOff ? <Badge tone="neutral">Off on TikTok</Badge> : null}
    </label>
  );
}
