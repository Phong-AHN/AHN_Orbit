'use client';

import * as React from 'react';
import { Alert, Badge, Button, Field, Select } from '@orbit/ui';
import { ApiError } from './api';

/**
 * YouTube's per-post settings (SRS §7).
 *
 * **The declaration is the point of this panel.** YouTube requires every upload
 * to say whether it is made for children, and that is an audience statement
 * under COPPA rather than a preference — it changes what YouTube does with
 * comments, personalised ads and notifications. Orbit will not answer it on a
 * client's behalf, so there is no default here and no default in the adapter: a
 * post with nothing chosen is refused before anything is uploaded.
 *
 * There is no "post as a Short" control, because YouTube has no such flag. A
 * vertical video short enough becomes a Short on its own, and a switch that
 * pretended otherwise would be a lie in a dropdown.
 *
 * Saved on an explicit button, like TikTok's panel and for the same reason: a
 * half-made set of choices saved one control at a time reads as the choice not
 * having registered.
 */

export type YouTubePrivacy = 'public' | 'unlisted' | 'private';

export interface YouTubeOptions {
  madeForKids?: boolean;
  privacyStatus?: YouTubePrivacy;
}

export interface YouTubeOptionsProps {
  socialAccountId: string;
  accountName: string;
  /** What the server currently holds for this variant. */
  saved: YouTubeOptions;
  disabled: boolean;
  /** Persist. Resolves once the server has confirmed. */
  onSave: (next: YouTubeOptions) => Promise<void>;
}

export function YouTubeOptionsPanel({
  socialAccountId,
  accountName,
  saved,
  disabled,
  onSave,
}: YouTubeOptionsProps) {
  const [value, setValue] = React.useState<YouTubeOptions>(saved);
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  /**
   * Follow the server when it changes underneath — a different account tab, or
   * a value written elsewhere.
   *
   * Keyed on the *contents*, not the object: the parent builds `saved` from
   * `platformOptions ?? {}`, a fresh object every render, so depending on the
   * reference would wipe a half-made selection whenever anything else on the
   * page re-rendered.
   */
  const savedKey = JSON.stringify(saved);

  React.useEffect(() => {
    setValue(JSON.parse(savedKey) as YouTubeOptions);
    setSavedAt(null);
  }, [savedKey]);

  const onChange = (next: YouTubeOptions) => {
    setValue(next);
    setSavedAt(null);
  };

  // Field by field rather than by serialising: key order differs between what
  // the server returns and what this builds, and a string comparison would
  // report every panel as unsaved on first render.
  const dirty =
    value.madeForKids !== saved.madeForKids ||
    (value.privacyStatus ?? 'private') !== (saved.privacyStatus ?? 'private');

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

  const audience = value.madeForKids === undefined ? '' : value.madeForKids ? 'KIDS' : 'NOT_KIDS';

  return (
    <div className="space-y-3 rounded-lg border border-line bg-surface-sunken p-3">
      <p className="flex items-center gap-2 text-sm font-medium text-ink">
        YouTube settings
        <Badge tone="neutral">{accountName}</Badge>
      </p>

      <Field
        label="Is this made for children?"
        htmlFor={`youtube-audience-${socialAccountId}`}
        hint="YouTube requires an answer on every upload. It is a declaration about the audience, not a visibility setting."
      >
        <Select
          id={`youtube-audience-${socialAccountId}`}
          value={audience}
          disabled={disabled || saving}
          onChange={(event) => {
            // "Choose…" means unanswered, and unanswered is a real state the
            // adapter refuses on — not a value to coerce into false.
            const { madeForKids: _dropped, ...rest } = value;
            if (event.target.value === '') onChange(rest);
            else onChange({ ...rest, madeForKids: event.target.value === 'KIDS' });
          }}
        >
          <option value="">Choose&hellip;</option>
          <option value="NOT_KIDS">No, not made for kids</option>
          <option value="KIDS">Yes, made for kids</option>
        </Select>
      </Field>

      {/* Said before the choice, not after the failure. Somebody answering this
          on a client's behalf should know what it does. */}
      {value.madeForKids === true ? (
        <Alert tone="info" title="Made-for-kids videos are treated differently">
          YouTube turns off comments, personalised ads, notifications and saving to playlists on
          videos marked made for kids. It applies to the video, not to the channel.
        </Alert>
      ) : null}

      {value.madeForKids === undefined ? (
        <p className="text-xs text-warning">
          Until this is answered, the post will not publish — YouTube will not accept an upload
          without it, and Orbit will not answer it for you.
        </p>
      ) : null}

      <Field
        label="Who can see it"
        htmlFor={`youtube-privacy-${socialAccountId}`}
        hint="Unlisted means anybody with the link can watch it, but it does not appear in search or on the channel."
      >
        <Select
          id={`youtube-privacy-${socialAccountId}`}
          value={value.privacyStatus ?? 'private'}
          disabled={disabled || saving}
          onChange={(event) => {
            onChange({ ...value, privacyStatus: event.target.value as YouTubePrivacy });
          }}
        >
          {/* Private is first *and* the default: an upload that goes out
              publicly by accident cannot be taken back, and Orbit does not hold
              the scope to delete it. */}
          <option value="private">Private</option>
          <option value="unlisted">Unlisted</option>
          <option value="public">Public</option>
        </Select>
      </Field>

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button
          size="sm"
          variant="secondary"
          loading={saving}
          disabled={disabled || saving || !dirty}
          onClick={() => void save()}
        >
          Save YouTube settings
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
