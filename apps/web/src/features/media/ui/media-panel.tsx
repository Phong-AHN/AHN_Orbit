'use client';

import * as React from 'react';
import { Button, Card, CardBody, CardHeader, CardTitle, Input, cn } from '@orbit/ui';
import { ApiError } from '@/features/posts/ui/api';
import { completeUpload, presignUpload, putToStorage, viewUrl } from './api';
import { describeFacts, formatType, type MediaFacts } from './facts';
import { LibraryPicker } from './library-picker';
import { GenerateImage } from './generate-image';
import {
  SLIDE_DRAG_TYPE,
  attachmentLimits,
  collectUploaded,
  isFileDrag,
  moveItem,
  runWithConcurrency,
  type LimitStatus,
  type PlatformLimit,
} from './upload-plan';

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
  /**
   * Each target platform's attachment limit, for the counter.
   *
   * Display only. The counter mirrors the character counter — a number and a
   * colour — and refuses nothing; `/validate` still decides.
   */
  limits?: PlatformLimit[];
  /** Called with the full list whenever it changes; the caller saves it. */
  onChange: (items: MediaItem[]) => void;
}

type FileStatus = 'waiting' | 'reserving' | 'uploading' | 'checking' | 'done' | 'failed';

interface QueuedFile {
  key: string;
  name: string;
  status: FileStatus;
  error?: string | undefined;
}

/**
 * How many files upload at once.
 *
 * Three, because the work is mostly waiting on the network and on the server's
 * verification, so a little parallelism removes most of the wait — while more
 * than that competes for the same upstream link and makes each one slower,
 * which on a phone hotspot is how a batch of eight stalls entirely.
 */
const UPLOAD_CONCURRENCY = 3;

/** What the picker offers. A dropped file bypasses `accept`, so it is checked too. */
const ACCEPTED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/quicktime',
];

export function MediaPanel({
  orgSlug,
  workspaceId,
  brandId,
  items,
  disabled,
  limits = [],
  onChange,
}: MediaPanelProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [queue, setQueue] = React.useState<QueuedFile[]>([]);
  const [uploading, setUploading] = React.useState(false);
  const [dropActive, setDropActive] = React.useState(false);
  const [dragIndex, setDragIndex] = React.useState<number | null>(null);
  const [announcement, setAnnouncement] = React.useState('');
  // Counts dragenter/dragleave pairs: moving over a child fires `dragleave` on
  // the parent, which would otherwise flicker the drop overlay off and on.
  const dragDepth = React.useRef(0);

  /**
   * The list as it is *now*, not as it was when an upload began.
   *
   * This is the bug behind "I can only upload one at a time". The loop used to
   * call `onChange([...items, asset])` with `items` captured when the upload
   * started, so every file in a batch replaced the one before it and only the
   * last survived — the others uploaded, landed in the library, and were never
   * attached. Reading through a ref means a batch appends to what is really
   * there.
   */
  const latestItems = React.useRef(items);
  React.useEffect(() => {
    latestItems.current = items;
  }, [items]);

  const locked = Boolean(disabled) || uploading;

  function setStatus(index: number, status: FileStatus, error?: string) {
    setQueue((current) =>
      current.map((entry, i) => (i === index ? { ...entry, status, error } : entry)),
    );
  }

  async function uploadOne(file: File, index: number): Promise<MediaItem | null> {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setStatus(index, 'failed', `${file.name} is not a supported image or video type.`);
      return null;
    }

    try {
      setStatus(index, 'reserving');
      const presigned = await presignUpload(orgSlug, {
        workspaceId,
        brandId,
        filename: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      });

      setStatus(index, 'uploading');
      await putToStorage(presigned.uploadUrl, file);

      setStatus(index, 'checking');
      const { asset } = await completeUpload(orgSlug, presigned.assetId);

      if (asset.status !== 'READY') {
        // Verification rejected the bytes and has already deleted the object.
        setStatus(
          index,
          'failed',
          `${file.name} was rejected: the file is not a valid ${file.type || 'image'}.`,
        );
        return null;
      }

      setStatus(index, 'done');
      return itemFromAsset(asset);
    } catch (e) {
      setStatus(index, 'failed', describeFailure(e, file.name));
      throw e;
    }
  }

  async function add(files: FileList | File[] | null) {
    const list = files ? Array.from(files) : [];
    if (list.length === 0) return;

    setUploading(true);
    setQueue(
      list.map((file, i) => ({ key: `${i}-${file.name}`, name: file.name, status: 'waiting' })),
    );

    try {
      // In parallel, but the results come back in the order the files were
      // chosen, so a numbered carousel is not scrambled by whichever image
      // happened to finish first.
      const results = await runWithConcurrency(list, UPLOAD_CONCURRENCY, uploadOne);
      const uploaded = collectUploaded(results);

      // One save for the whole batch. Each save replaces every media row and
      // re-validates the post, so eight saves for eight files was eight round
      // trips doing the same work.
      if (uploaded.length > 0) {
        onChange([...latestItems.current, ...uploaded]);
        setAnnouncement(`${uploaded.length} ${uploaded.length === 1 ? 'file' : 'files'} attached.`);
      }

      // Successful rows leave the queue; failed ones stay until dismissed, so
      // somebody can see exactly which of a batch need sending again.
      setQueue((current) => current.filter((entry) => entry.status === 'failed'));
    } finally {
      setUploading(false);
      // So picking the same file twice in a row still fires a change event.
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  function update(index: number, patch: Partial<MediaItem>) {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function remove(index: number) {
    onChange(items.filter((_, i) => i !== index));
    setAnnouncement(`Slide ${index + 1} removed.`);
  }

  function move(from: number, to: number) {
    const target = Math.max(0, Math.min(items.length - 1, to));
    if (target === from) return;
    onChange(moveItem(items, from, target));
    setAnnouncement(`Slide moved to position ${target + 1} of ${items.length}.`);
  }

  // ── Dropping files from the desktop ────────────────────────────────────
  function onPanelDragEnter(event: React.DragEvent) {
    if (locked || !isFileDrag(Array.from(event.dataTransfer.types))) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDropActive(true);
  }

  function onPanelDragOver(event: React.DragEvent) {
    if (locked || !isFileDrag(Array.from(event.dataTransfer.types))) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function onPanelDragLeave(event: React.DragEvent) {
    if (!isFileDrag(Array.from(event.dataTransfer.types))) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropActive(false);
  }

  function onPanelDrop(event: React.DragEvent) {
    if (!isFileDrag(Array.from(event.dataTransfer.types))) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDropActive(false);
    if (!locked) void add(event.dataTransfer.files);
  }

  const status = attachmentLimits(items.length, limits);

  return (
    <Card>
      <div
        onDragEnter={onPanelDragEnter}
        onDragOver={onPanelDragOver}
        onDragLeave={onPanelDragLeave}
        onDrop={onPanelDrop}
        className={cn(
          'relative rounded-[inherit]',
          dropActive && 'ring-2 ring-accent ring-offset-2 ring-offset-surface',
        )}
      >
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Images and video</CardTitle>
          {status.binding ? <LimitCounter count={items.length} status={status} /> : null}
        </CardHeader>

        <CardBody className="space-y-3">
          {items.length === 0 ? (
            <p className="text-sm text-ink-muted">
              Nothing attached. Instagram and TikTok need an image or a video; Facebook can post
              text on its own.
            </p>
          ) : (
            <ol className="space-y-2" aria-label="Attached slides, in publishing order">
              {items.map((item, index) => (
                <li
                  key={item.mediaAssetId}
                  draggable={!locked && items.length > 1}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(SLIDE_DRAG_TYPE, String(index));
                    event.dataTransfer.effectAllowed = 'move';
                    setDragIndex(index);
                  }}
                  onDragEnd={() => setDragIndex(null)}
                  onDragOver={(event) => {
                    if (!Array.from(event.dataTransfer.types).includes(SLIDE_DRAG_TYPE)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                  }}
                  onDrop={(event) => {
                    if (!Array.from(event.dataTransfer.types).includes(SLIDE_DRAG_TYPE)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const from = Number(event.dataTransfer.getData(SLIDE_DRAG_TYPE));
                    if (Number.isInteger(from)) move(from, index);
                    setDragIndex(null);
                  }}
                  className={cn(
                    'rounded border border-line p-2',
                    dragIndex === index && 'opacity-50',
                    !locked && items.length > 1 && 'cursor-grab active:cursor-grabbing',
                  )}
                >
                  <div className="flex items-start gap-3">
                    <span
                      aria-hidden="true"
                      className="mt-1 grid size-6 shrink-0 place-items-center rounded-full bg-surface-sunken text-xs font-semibold text-ink-secondary"
                    >
                      {index + 1}
                    </span>

                    <Thumbnail orgSlug={orgSlug} item={item} />

                    <div className="min-w-0 flex-1 space-y-2">
                      <FileFacts item={item} />

                      <AltTextInput
                        value={item.altText}
                        disabled={locked}
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

                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {items.length > 1 ? (
                        /* The keyboard and touch route to reordering. Dragging is
                           a convenience on top; these work everywhere, including
                           on a phone, where HTML drag-and-drop does not. */
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={locked || index === 0}
                            aria-label={`Move slide ${index + 1} earlier`}
                            onClick={() => move(index, index - 1)}
                          >
                            ←
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={locked || index === items.length - 1}
                            aria-label={`Move slide ${index + 1} later`}
                            onClick={() => move(index, index + 1)}
                          >
                            →
                          </Button>
                        </div>
                      ) : null}

                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={locked}
                        onClick={() => remove(index)}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}

          {queue.length > 0 ? <UploadQueue queue={queue} onDismiss={() => setQueue([])} /> : null}

          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={inputRef}
              type="file"
              className="sr-only"
              multiple
              accept={ACCEPTED_TYPES.join(',')}
              onChange={(event) => void add(event.target.files)}
            />

            <Button
              variant="secondary"
              size="sm"
              loading={uploading}
              loadingLabel="Uploading files"
              disabled={locked}
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
              disabled={locked}
              onPick={(picked) =>
                onChange([
                  ...items,
                  ...picked
                    .filter((asset) => !items.some((item) => item.mediaAssetId === asset.id))
                    .map(itemFromAsset),
                ])
              }
            />

            {/* An AI image lands in the library like an upload, and is attached here (D-110). */}
            <GenerateImage
              orgSlug={orgSlug}
              target={{ workspaceId, brandId }}
              disabled={locked}
              confirmLabel="Attach to post"
              onGenerated={(asset) => onChange([...items, itemFromAsset(asset)])}
            />

            <span className="text-xs text-ink-muted">
              Select several files at once, or drop them here. Images: JPEG, PNG, GIF or WebP —
              Instagram accepts JPEG only. Video: MP4 or MOV, vertical, 3–90 seconds.
            </span>
          </div>

          {/* Spoken to screen readers: an upload finishing and a slide moving
              both change the page somewhere other than where focus is. */}
          <p aria-live="polite" className="sr-only">
            {announcement}
          </p>
        </CardBody>

        {dropActive ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 grid place-items-center rounded-[inherit] bg-accent-soft text-sm font-semibold text-accent"
          >
            Drop to upload
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * "8 / 10" beside the heading.
 *
 * The binding limit is the lowest among the post's platforms — Instagram's 10
 * binds a post that also goes to Threads, whose limit is 20. Over it, the
 * counter names every platform that would refuse, because "too many" without
 * saying for which account sends somebody guessing.
 */
function LimitCounter({ count, status }: { count: number; status: LimitStatus }) {
  const binding = status.binding as PlatformLimit;
  const over = status.over.length > 0;

  return (
    <p
      className={cn('text-xs tabular-nums', over ? 'font-semibold text-danger' : 'text-ink-muted')}
    >
      {count} / {binding.max}
      <span className="font-normal">
        {over
          ? ` — over the limit for ${status.over.map((l) => platformName(l.platform)).join(', ')}`
          : ` — ${platformName(binding.platform)}'s limit`}
      </span>
    </p>
  );
}

function platformName(platform: string): string {
  return platform.charAt(0) + platform.slice(1).toLowerCase();
}

const QUEUE_LABEL: Record<FileStatus, string> = {
  waiting: 'Waiting',
  reserving: 'Preparing',
  uploading: 'Uploading',
  checking: 'Checking the file',
  done: 'Attached',
  failed: 'Failed',
};

/**
 * One line per file in the batch.
 *
 * Every failure is listed, not just the last: a batch of eight where two fail
 * used to show one error, overwritten by the next, so the other failure was
 * never seen and the slide was simply missing from the post.
 */
function UploadQueue({ queue, onDismiss }: { queue: QueuedFile[]; onDismiss: () => void }) {
  const finished = queue.every((entry) => entry.status === 'failed' || entry.status === 'done');

  return (
    <div className="rounded border border-line">
      <ul className="divide-y divide-line">
        {queue.map((entry) => (
          <li key={entry.key} className="px-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-ink-secondary" title={entry.name}>
                {entry.name}
              </span>
              <span
                className={cn(
                  'shrink-0',
                  entry.status === 'failed'
                    ? 'font-semibold text-danger'
                    : entry.status === 'done'
                      ? 'text-success'
                      : 'text-ink-muted',
                )}
              >
                {QUEUE_LABEL[entry.status]}
              </span>
            </div>
            {entry.error ? (
              <p role="alert" className="mt-1 text-danger">
                {entry.error}
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      {finished ? (
        <div className="border-t border-line px-3 py-2 text-right">
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      ) : null}
    </div>
  );
}

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
