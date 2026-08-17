'use client';

import * as React from 'react';
import { Button, Card, CardBody, CardHeader, CardTitle, Input } from '@orbit/ui';
import { ApiError } from '@/features/posts/ui/api';
import { completeUpload, presignUpload, putToStorage, viewUrl } from './api';
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

export interface MediaItem {
  mediaAssetId: string;
  kind: string;
  mimeType: string;
  altText: string;
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

        onChange([
          ...items,
          { mediaAssetId: asset.id, kind: asset.kind, mimeType: asset.mimeType, altText: '' },
        ]);
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
            Nothing attached. Instagram cannot publish without an image; Facebook can.
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((item, index) => (
              <li key={item.mediaAssetId} className="rounded border border-line p-2">
                <div className="flex items-start gap-3">
                  <Thumbnail orgSlug={orgSlug} item={item} />

                  <div className="min-w-0 flex-1 space-y-2">
                    <Input
                      aria-label="Alt text"
                      placeholder="Describe this image for people using a screen reader"
                      value={item.altText}
                      disabled={disabled || busy}
                      maxLength={1000}
                      onChange={(event) => update(index, { altText: event.target.value })}
                    />

                    {item.kind === 'VIDEO' ? (
                      <p className="text-xs text-warning">
                        Video uploads and stores fine, but neither Facebook nor Instagram publishing
                        is built for it yet — a post with video will not pass its checks.
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
                  .map((asset) => ({
                    mediaAssetId: asset.id,
                    kind: asset.kind,
                    mimeType: asset.mimeType,
                    altText: '',
                  })),
              ])
            }
          />

          {/* Named in full because the `accept` attribute already allows video
              and this line did not mention it — which reads as "video is not
              supported" and is the reason a perfectly good clip went untried. */}
          <span className="text-xs text-ink-muted">
            Images: JPEG, PNG, GIF or WebP — Instagram accepts JPEG only. Video: MP4 or MOV, for
            TikTok.
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
