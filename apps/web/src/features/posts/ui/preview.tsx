'use client';

import * as React from 'react';
import { Badge } from '@orbit/ui';
import { viewUrl } from '@/features/media/ui/api';
import type { MediaItem } from '@/features/media/ui/media-panel';
import type { CapabilitySummary } from './capability-summary';
import { previewNotes, previewShape, type PreviewShape } from './preview-shape';

/**
 * What this will look like in the feed (SRS §9).
 *
 * The composer already tells you whether a post is *valid*. It could not tell
 * you whether it **reads** well, and those are different questions: a caption
 * well inside Instagram's 2,200 characters still loses everything after the
 * first line in the feed, and a Facebook post and an Instagram post built from
 * the same text look nothing alike.
 *
 * **This is a sketch, never a verdict.** It deliberately does no validation —
 * `/validate` runs the real engine server-side against the full capability
 * descriptor, and a second opinion rendered in the browser is exactly the drift
 * that engine exists to prevent. Nothing here can make a post publishable or
 * refuse one, and nothing here is ever compared against a limit.
 *
 * The claims it makes — where the caption folds, whether a link is clickable —
 * live in `preview-shape.ts`, pure and tested. What is left here is chrome.
 */

export interface PostPreviewProps {
  orgSlug: string;
  platform: string;
  accountName: string;
  handle: string | null;
  /** The text this account will actually publish — override or inherited. */
  text: string;
  media: MediaItem[];
  firstComment: string;
  capability: CapabilitySummary | undefined;
}

export function PostPreview({
  orgSlug,
  platform,
  accountName,
  handle,
  text,
  media,
  firstComment,
  capability,
}: PostPreviewProps) {
  const shape = previewShape(platform);
  const [expanded, setExpanded] = React.useState(false);

  const trimmed = text.trim();
  const folded = trimmed.length > shape.foldAt && !expanded;
  const shown = folded ? trimmed.slice(0, shape.foldAt).trimEnd() : trimmed;

  const images = media.filter((item) => item.kind === 'IMAGE');
  const first = media[0];

  const caption = (
    <div className="px-3 py-2">
      {trimmed.length === 0 ? (
        <p className="text-sm italic text-ink-muted">No text yet.</p>
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm text-ink">
          {shown}
          {folded ? (
            <>
              <span aria-hidden="true">… </span>
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="text-sm text-ink-muted hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {shape.foldLabel}
              </button>
            </>
          ) : null}
        </p>
      )}
    </div>
  );

  const body = first ? <PreviewMedia orgSlug={orgSlug} item={first} shape={shape} /> : null;

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="flex items-center gap-2 px-3 py-2">
          <span
            aria-hidden="true"
            className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-sunken text-xs font-semibold text-ink-muted"
          >
            {accountName.slice(0, 2).toUpperCase()}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-ink">{accountName}</span>
            <span className="block truncate text-xs text-ink-muted">
              {handle ? `@${handle} · ` : ''}Just now
            </span>
          </span>
        </div>

        {shape.captionBelow ? (
          <>
            {body}
            {caption}
          </>
        ) : (
          <>
            {caption}
            {body}
          </>
        )}

        {/* Only the first attachment is drawn. Saying how many more there are
            beats drawing a carousel that would still not match the real one. */}
        {media.length > 1 ? (
          <p className="border-t border-line px-3 py-1.5 text-xs text-ink-muted">
            {media.length} attachments
            {capability?.carousel === false ? ' — this account posts them separately' : ''}
          </p>
        ) : null}

        {firstComment.trim().length > 0 ? (
          <div className="border-t border-line px-3 py-2">
            <p className="text-xs font-medium text-ink-muted">First comment</p>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-ink-secondary">
              {firstComment.trim()}
            </p>
          </div>
        ) : null}
      </div>

      <Notes
        notes={previewNotes({
          platform,
          text: trimmed,
          hasMedia: media.length > 0,
          imageCount: images.length,
          mediaRequired: capability?.mediaRequired ?? false,
        })}
      />
    </div>
  );
}

function Notes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;

  return (
    <ul className="space-y-1">
      {notes.map((note) => (
        <li key={note} className="flex gap-1.5 text-xs text-ink-muted">
          <Badge tone="neutral">Note</Badge>
          <span className="self-center">{note}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A signed, expiring URL — the same route the media panel uses, for the same
 * reason: it proves the bytes are readable back out of storage, which is what
 * will be true at publish time.
 */
function PreviewMedia({
  orgSlug,
  item,
  shape,
}: {
  orgSlug: string;
  item: MediaItem;
  shape: PreviewShape;
}) {
  const [url, setUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setUrl(null);

    viewUrl(orgSlug, item.mediaAssetId)
      .then((result) => {
        if (!cancelled) setUrl(result.url);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [orgSlug, item.mediaAssetId]);

  const frame =
    shape.aspect === 'square'
      ? 'aspect-square'
      : shape.aspect === 'portrait'
        ? 'aspect-[9/16]'
        : 'aspect-[4/3]';

  if (item.kind === 'VIDEO') {
    // No frame is drawn: a poster would have to be generated, and a black
    // rectangle claiming to be the video is less honest than saying so.
    return (
      <div className={`grid ${frame} w-full place-items-center bg-surface-sunken`}>
        <span className="text-xs text-ink-muted">Video</span>
      </div>
    );
  }

  // A plain <img> rather than next/image: a signed URL that expires in minutes
  // and points at this deployment's bucket is the opposite of what an image
  // optimiser wants to cache and rewrite.
  return url ? (
    <img
      src={url}
      alt={item.altText || ''}
      className={`${frame} w-full bg-surface-sunken object-cover`}
    />
  ) : (
    <div className={`${frame} w-full animate-pulse bg-surface-sunken`} />
  );
}
