'use client';

import * as React from 'react';
import { Button, Card, CardBody, CardHeader, CardTitle, Input } from '@orbit/ui';
import { ApiError } from '@/features/posts/ui/api';
import { completeUpload, presignUpload, putToStorage, viewUrl } from './api';
import { describeFacts, formatType, type MediaFacts } from './facts';
import { LibraryPicker } from './library-picker';

/**
 * Attaching images and video to a post.
 *
 * The upload is deliberately three-legged — presign, PUT to S3, complete — and
 * the panel shows which leg failed rather than a single "upload failed", because
 * the three fail for completely different reasons: a plan limit, a bucket that
 * does not allow this origin, and a file whose bytes are not what its name
 * claimed.
 *
 * A file is not attached until the server has *verified* it. Until `complete`
 * succeeds the asset is PENDING and the post layer refuses to attach it, so the
 * optimistic thumbnail here would be a lie — hence the explicit "checking" state
 * rather than showing it as done the moment the PUT returns.
 */

export interface AttachedMedia {
  mediaAssetId: string;
  altText?: string;
}

/**
 * An attachment as the composer holds it.
 *
 * `MediaFacts` is spread in rather than nested so the measured numbers travel
 * with the item everywhere it already goes — the preview, the save payload, the
 * requirement panel — without every call site learning a new shape. They are
 * all optional because the server may genuinely not have them: probing a file
 * can fail, and an unmeasured dimension is absent, never zero.
 */
export interface MediaItem extends MediaFacts {
  mediaAssetId: string;
  altText: string;
  originalFilename?: string | undefined;
}

/**
 * Build an attachment from any asset response that carries the facts.
 *
 * Structural rather than `Pick<MediaAsset, …>`, because the upload response and
 * the library listing describe `kind` differently — one as a union, one as a
 * string — while both come from the same column. The looser shape is what lets
 * one function serve both, so a file attached from the library shows exactly
 * what the same file shows after an upload.
 */
export function itemFromAsset(asset: {
  id: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  frameRate: number | null;
  peakFrameRate: number | null;
  originalFilename: string | null;
}): MediaItem {
  return {
    mediaAssetId: asset.id,
    kind: asset.kind,
    mimeType: asset.mimeType,
    altText: '',
    sizeBytes: asset.sizeBytes,
    width: asset.width ?? undefined,
    height: asset.height ?? undefined,
    durationMs: asset.durationMs ?? undefined,
    frameRate: asset.frameRate ?? undefined,
    peakFrameRate: asset.peakFrameRate ?? undefined,
    originalFilename: asset.originalFilename ?? undefined,
  };
}

export interface MediaPanelProps {
  orgSlug: string;
  workspaceId: string;
  brandId: string;
  items: MediaItem[];
  disabled?: boolean;
  /** Called with the full list whenever it changes; the caller saves it. */
  onChange: (items: MediaItem[]) => void;
}

type Stage = 'reserving' | 'uploading' | 'checking';

export function MediaPanel({
  orgSlug,
  workspaceId,
  brandId,
  items,
  disabled,
  onChange,
}: MediaPanelProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [stage, setStage] = React.useState<Stage | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function add(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);

    for (const file of Array.from(files)) {
      try {
        setStage('reserving');
        const presigned = await presignUpload(orgSlug, {
          workspaceId,
          brandId,
          filename: file.name,
          contentType: file.type,
          sizeBytes: file.size,
        });

        setStage('uploading');
        await putToStorage(presigned.uploadUrl, file);

        setStage('checking');
        const { asset } = await completeUpload(orgSlug, presigned.assetId);

        if (asset.status !== 'READY') {
          // Verification rejected the bytes and has already deleted the object.
          setError(`${file.name} was rejected: the file is not a valid ${file.type || 'image'}.`);
          continue;
        }

        onChange([...items, itemFromAsset(asset)]);
      } catch (e) {
        setError(describeFailure(e, file.name));
      } finally {
        setStage(null);
      }
    }

    // So picking the same file twice in a row still fires a change event.
    if (inputRef.current) inputRef.current.value = '';
  }

  function update(index: number, patch: Partial<MediaItem>) {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function remove(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  const busy = stage !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Images and video</CardTitle>
      </CardHeader>

      <CardBody className="space-y-3">
        {items.length === 0 ? (
          <p className="text-sm text-ink-muted">
            Nothing attached. Instagram and TikTok need an image or a video; Facebook can post text
            on its own.
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((item, index) => (
              <li key={item.mediaAssetId} className="rounded border border-line p-2">
                <div className="flex items-start gap-3">
                  <Thumbnail orgSlug={orgSlug} item={item} />

                  <div className="min-w-0 flex-1 space-y-2">
                    <FileFacts item={item} />

                    <AltTextInput
                      value={item.altText}
                      disabled={disabled || busy}
                      onCommit={(altText) => {
                        if (altText !== item.altText) update(index, { altText });
                      }}
                    />

                    {item.kind === 'VIDEO' ? (
                      <p className="text-xs text-ink-muted">
                        Publishes as a Reel on Facebook and Instagram, and as a post on TikTok.
                      </p>
                    ) : null}
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled || busy}
                    onClick={() => remove(index)}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <input
            ref={inputRef}
            type="file"
            className="sr-only"
            multiple
            accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime"
            onChange={(event) => void add(event.target.files)}
          />

          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            loadingLabel={STAGE_LABEL[stage ?? 'reserving']}
            disabled={disabled || busy}
            onClick={() => inputRef.current?.click()}
          >
            Upload
          </Button>

          {/* Reuse before re-upload: the same photograph attached twice used to
              mean two objects in the bucket and two rows in the library. */}
          <LibraryPicker
            orgSlug={orgSlug}
            brandId={brandId}
            attachedIds={items.map((item) => item.mediaAssetId)}
            disabled={disabled || busy}
            onPick={(picked) =>
              onChange([
                ...items,
                ...picked
                  .filter((asset) => !items.some((item) => item.mediaAssetId === asset.id))
                  .map(itemFromAsset),
              ])
            }
          />

          {/* Named in full because the `accept` attribute already allows video
              and this line did not mention it — which reads as "video is not
              supported" and is the reason a perfectly good clip went untried. */}
          <span className="text-xs text-ink-muted">
            Images: JPEG, PNG, GIF or WebP — Instagram accepts JPEG only. Video: MP4 or MOV,
            vertical, 3–90 seconds.
          </span>
        </div>
      </CardBody>
    </Card>
  );
}

const STAGE_LABEL: Record<Stage, string> = {
  reserving: 'Preparing…',
  uploading: 'Uploading…',
  checking: 'Checking the file…',
};

/**
 * What this file actually is, measured from its own bytes at upload.
 *
 * Shown on every attachment, not only when something is wrong. A limit is only
 * useful next to the figure it applies to, and the figures were already in the
 * database — the composer simply never asked for them, so "your video is too
 * long" arrived with no way to tell *how* long it was.
 *
 * It states facts and no verdict. Whether the file is acceptable depends on
 * which accounts the post targets, which only `/validate` knows.
 */
function FileFacts({ item }: { item: MediaItem }) {
  const parts = describeFacts(item);
  const name = item.originalFilename;

  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-muted">
      {name ? (
        // Truncated rather than wrapped: the useful end of a phone filename is
        // the start, and a 60-character name should not push the facts off.
        <span className="max-w-[16rem] truncate font-medium text-ink-secondary" title={name}>
          {name}
        </span>
      ) : null}

      <span className="rounded-sm bg-surface-sunken px-1 py-px font-medium">
        {formatType(item.mimeType)}
      </span>

      {parts.length > 0 ? (
        <span>{parts.join(' · ')}</span>
      ) : (
        /* An absent measurement is reported as absent. Showing nothing would
           read as a file with no properties; zeros would be a fabrication. */
        <span className="italic">dimensions not measured</span>
      )}
    </p>
  );
}

/**
 * The thumbnail is fetched through a signed URL rather than rendered from the
 * local `File`. A little slower, and it proves the object is actually readable
 * back out of storage — which is the thing that will be true at publish time.
 */
function Thumbnail({ orgSlug, item }: { orgSlug: string; item: MediaItem }) {
  const [url, setUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

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

  if (item.kind === 'VIDEO') {
    return (
      <div className="grid size-16 shrink-0 place-items-center rounded bg-surface-sunken text-xs text-ink-muted">
        Video
      </div>
    );
  }

  // A plain <img>, not next/image: the source is a signed URL that expires in
  // minutes and points at whatever bucket host this deployment uses, which is
  // the opposite of what an image optimiser wants to cache and rewrite.
  return url ? (
    <img src={url} alt="" className="size-16 shrink-0 rounded object-cover" />
  ) : (
    <div className="size-16 shrink-0 rounded bg-surface-sunken" />
  );
}

/**
 * Each leg of the upload fails for its own reason, and saying which is the
 * difference between a fixable problem and a shrug.
 */
function describeFailure(error: unknown, filename: string): string {
  if (error instanceof ApiError) return error.message;

  // `fetch` throws a TypeError before any response when the browser blocks the
  // request — which for a cross-origin PUT means the bucket's CORS rules, not
  // anything about the file.
  if (error instanceof TypeError) {
    return `${filename} could not be sent to storage. The bucket is not accepting uploads from this site — check its CORS configuration.`;
  }

  return error instanceof Error ? error.message : `${filename} could not be uploaded.`;
}

/**
 * Alt text that is typed locally and saved once.
 *
 * The field used to be driven straight from the parent, so every keystroke ran
 * the whole attachment list through the update endpoint — a hundred-character
 * description meant a hundred requests, each one deleting and recreating the
 * post's media rows. It also made the caret jump whenever a response landed out
 * of order.
 *
 * So the text lives here while it is being written and commits on blur, or on
 * Enter for anyone who never leaves the keyboard. Escape abandons the edit.
 *
 * Deliberately **not** a debounce: a timer saves at an arbitrary moment mid-word
 * and gives no signal about when the work is safe. Blur is a real boundary that
 * a person can see, and it is the same moment they would expect a form field to
 * settle.
 */
function AltTextInput({
  value,
  disabled,
  onCommit,
}: {
  value: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = React.useState(value);

  // Follow the parent when it changes underneath — a different asset in this
  // slot, or a value the server rewrote.
  React.useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <Input
      aria-label="Alt text"
      placeholder="Describe this image for people using a screen reader"
      value={draft}
      disabled={disabled}
      maxLength={1000}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}
