'use client';

import * as React from 'react';

/**
 * The Direct Post form, built to TikTok's Content Posting UX guidelines —
 * which is what TikTok's reviewers check this page against:
 *
 * - the creator's nickname is shown, so they know where it posts;
 * - privacy has **no default** and lists only the options TikTok returned;
 * - Comment, Duet and Stitch start **unchecked**, and are greyed out when the
 *   creator turned them off in TikTok;
 * - commercial content disclosure is off by default; once on, "Your brand" or
 *   "Branded content" must be chosen, and branded content cannot be private;
 * - the consent line names the Music Usage Confirmation (and the Branded
 *   Content Policy when it applies), next to the Post button;
 * - the video is previewed before posting, and the post is the person's act.
 */

const PRIVACY_LABEL: Record<string, string> = {
  PUBLIC_TO_EVERYONE: 'Everyone',
  MUTUAL_FOLLOW_FRIENDS: 'Friends',
  FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only me',
};

const MUSIC_URL = 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en';
const BRANDED_URL = 'https://www.tiktok.com/legal/page/global/bc-policy/en';

export interface PostFormProps {
  nickname: string;
  privacyOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxDurationSec: number;
  maxBytes: number;
}

export function PostForm({
  nickname,
  privacyOptions,
  commentDisabled,
  duetDisabled,
  stitchDisabled,
  maxDurationSec,
  maxBytes,
}: PostFormProps) {
  const [preview, setPreview] = React.useState<string | null>(null);
  const [fileProblem, setFileProblem] = React.useState<string | null>(null);
  const [privacy, setPrivacy] = React.useState('');
  const [disclose, setDisclose] = React.useState(false);
  const [brandOrganic, setBrandOrganic] = React.useState(false);
  const [brandContent, setBrandContent] = React.useState(false);
  const [consent, setConsent] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setFileProblem(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    if (!file) return;
    if (file.size > maxBytes) {
      setFileProblem(`Choose a video under ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
  }

  function checkDuration(event: React.SyntheticEvent<HTMLVideoElement>) {
    const seconds = event.currentTarget.duration;
    if (maxDurationSec > 0 && Number.isFinite(seconds) && seconds > maxDurationSec) {
      setFileProblem(`This account can post videos up to ${maxDurationSec} seconds.`);
    }
  }

  const brandedNeedsChoice = disclose && !brandOrganic && !brandContent;
  const ready =
    Boolean(preview) &&
    !fileProblem &&
    Boolean(privacy) &&
    consent &&
    !brandedNeedsChoice &&
    !submitting;

  return (
    <form
      method="post"
      action="/review/tiktok/post"
      encType="multipart/form-data"
      onSubmit={() => setSubmitting(true)}
      className="space-y-5 rounded-md border border-line bg-surface p-4 text-sm"
    >
      <p className="text-ink">
        Posting to <span className="font-semibold">{nickname || 'your TikTok account'}</span>
      </p>

      <label className="block">
        <span className="font-medium text-ink">Video</span>
        <input
          name="video"
          type="file"
          accept="video/mp4,video/quicktime,video/webm"
          required
          onChange={choose}
          className="mt-1 block text-sm"
        />
      </label>
      {fileProblem ? (
        <p role="alert" className="text-danger">
          {fileProblem}
        </p>
      ) : null}
      {preview ? (
        <video
          src={preview}
          controls
          onLoadedMetadata={checkDuration}
          className="max-h-80 rounded-md border border-line"
        />
      ) : null}

      <label className="block">
        <span className="font-medium text-ink">Caption</span>
        <textarea
          name="title"
          rows={3}
          maxLength={2_200}
          className="mt-1 block w-full rounded-md border border-line bg-surface px-3 py-2"
          placeholder="Write a caption"
        />
      </label>

      <label className="block">
        <span className="font-medium text-ink">Who can view this video</span>
        <select
          name="privacy"
          required
          value={privacy}
          onChange={(e) => setPrivacy(e.target.value)}
          className="mt-1 block rounded-md border border-line bg-surface px-3 py-2"
        >
          <option value="" disabled>
            Select who can view
          </option>
          {privacyOptions.map((option) => (
            <option
              key={option}
              value={option}
              // Branded content cannot be private.
              disabled={option === 'SELF_ONLY' && disclose && brandContent}
            >
              {PRIVACY_LABEL[option] ?? option}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="space-y-1">
        <legend className="font-medium text-ink">Allow users to</legend>
        {[
          { name: 'allowComment', label: 'Comment', disabled: commentDisabled },
          { name: 'allowDuet', label: 'Duet', disabled: duetDisabled },
          { name: 'allowStitch', label: 'Stitch', disabled: stitchDisabled },
        ].map((setting) => (
          <label
            key={setting.name}
            className={`mr-5 inline-flex items-center gap-1.5 ${setting.disabled ? 'text-ink-muted' : 'text-ink'}`}
          >
            <input type="checkbox" name={setting.name} disabled={setting.disabled} />
            {setting.label}
            {setting.disabled ? <span className="text-xs">(turned off in TikTok)</span> : null}
          </label>
        ))}
      </fieldset>

      <fieldset className="space-y-2 rounded-md border border-line p-3">
        <label className="flex items-center gap-2 font-medium text-ink">
          <input
            type="checkbox"
            name="disclose"
            checked={disclose}
            onChange={(e) => {
              setDisclose(e.target.checked);
              if (!e.target.checked) {
                setBrandOrganic(false);
                setBrandContent(false);
              }
            }}
          />
          Disclose video content
        </label>
        <p className="text-xs text-ink-secondary">
          Turn on to disclose that this video promotes goods or services in exchange for something
          of value.
        </p>
        {disclose ? (
          <div className="space-y-2 pl-6">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                name="brandOrganic"
                checked={brandOrganic}
                onChange={(e) => setBrandOrganic(e.target.checked)}
              />
              <span>
                <span className="font-medium text-ink">Your brand</span>
                <span className="block text-xs text-ink-secondary">
                  You are promoting yourself or your own business. Labelled “Promotional content”.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                name="brandContent"
                checked={brandContent}
                onChange={(e) => {
                  setBrandContent(e.target.checked);
                  if (e.target.checked && privacy === 'SELF_ONLY') setPrivacy('');
                }}
              />
              <span>
                <span className="font-medium text-ink">Branded content</span>
                <span className="block text-xs text-ink-secondary">
                  You are promoting another brand or a third party. Labelled “Paid partnership”.
                  Branded content cannot be private.
                </span>
              </span>
            </label>
            {brandedNeedsChoice ? (
              <p role="alert" className="text-xs text-danger">
                Choose at least one, or turn disclosure off.
              </p>
            ) : null}
          </div>
        ) : null}
      </fieldset>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          name="consent"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        <span className="text-ink-secondary">
          By posting, you agree to TikTok’s{' '}
          {disclose && brandContent ? (
            <>
              <a
                className="text-accent underline"
                href={BRANDED_URL}
                target="_blank"
                rel="noreferrer"
              >
                Branded Content Policy
              </a>{' '}
              and{' '}
            </>
          ) : null}
          <a className="text-accent underline" href={MUSIC_URL} target="_blank" rel="noreferrer">
            Music Usage Confirmation
          </a>
          .
        </span>
      </label>

      <button
        type="submit"
        disabled={!ready}
        className="rounded-md bg-accent px-4 py-2 font-medium text-accent-ink disabled:opacity-50"
      >
        {submitting ? 'Posting…' : 'Post to TikTok'}
      </button>
      <p className="text-xs text-ink-muted">
        After posting, TikTok can take a few minutes to process the video before it appears on the
        profile.
      </p>
    </form>
  );
}
