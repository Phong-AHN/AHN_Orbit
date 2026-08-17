'use client';

import * as React from 'react';
import { Alert, Badge, Field, Select, Spinner } from '@orbit/ui';
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
  value: TikTokOptions;
  disabled: boolean;
  onChange: (next: TikTokOptions) => void;
}

export function TikTokOptionsPanel({
  orgSlug,
  socialAccountId,
  accountName,
  value,
  disabled,
  onChange,
}: TikTokOptionsProps) {
  const [creator, setCreator] = React.useState<CreatorOptions | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const mode: PostMode = value.postMode ?? 'DIRECT_POST';

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    apiRequest<CreatorOptions>(
      `/api/v1/orgs/${encodeURIComponent(orgSlug)}/social-accounts/${encodeURIComponent(socialAccountId)}/tiktok-creator`,
    )
      .then((result) => {
        if (!cancelled) setCreator(result);
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setError(
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
          disabled={disabled}
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
      ) : error ? (
        <Alert tone="warning" title="TikTok&rsquo;s options could not be read">
          {error} Visibility has to come from TikTok, so this post cannot be published until it can
          be read.
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
              disabled={disabled}
              onChange={(event) => onChange({ ...value, privacyLevel: event.target.value })}
            >
              <option value="">Choose&hellip;</option>
              {creator.privacyLevels.map((level) => (
                <option key={level} value={level}>
                  {PRIVACY_LABEL[level] ?? level}
                </option>
              ))}
            </Select>
          </Field>

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
              disabled={disabled}
              onChange={(allow) => onChange({ ...value, disableComment: !allow })}
            />
            <Interaction
              id={`tiktok-duet-${socialAccountId}`}
              label="Allow duets"
              lockedOff={creator.duetDisabled}
              checked={!creator.duetDisabled && value.disableDuet !== true}
              disabled={disabled}
              onChange={(allow) => onChange({ ...value, disableDuet: !allow })}
            />
            <Interaction
              id={`tiktok-stitch-${socialAccountId}`}
              label="Allow stitches"
              lockedOff={creator.stitchDisabled}
              checked={!creator.stitchDisabled && value.disableStitch !== true}
              disabled={disabled}
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
