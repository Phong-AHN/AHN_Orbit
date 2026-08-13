import { ValidationError, type MediaKind } from '@orbit/core';
import { headObject, readRange } from './s3.js';
import { IMAGE_PROBE_BYTES, VIDEO_PROBE_BYTES, probeMedia, type MediaProbe } from './probe.js';
import { SNIFF_PREFIX_BYTES, declaredTypeMatches, sniff, UnsupportedMediaError } from './sniff.js';

/**
 * Post-upload verification (SRS §17, decision D-013).
 *
 * Runs *after* the browser has uploaded directly to S3, and is the moment the
 * file stops being a claim and becomes a known quantity. Until this passes the
 * asset stays PENDING and cannot be attached to a post.
 *
 * What it establishes, in order:
 *   1. the object exists and its real size;
 *   2. what the bytes actually are;
 *   3. whether that matches what the client said;
 *   4. the intrinsic dimensions or duration.
 */

export interface VerificationInput {
  key: string;
  /** What the client claimed at presign time. Compared, never trusted. */
  declaredMimeType: string;
  declaredSizeBytes: number;
  /** Ceiling for this upload, from plan limits. */
  maxBytes: number;
}

export interface VerifiedMedia {
  mimeType: string;
  kind: MediaKind;
  extension: string;
  sizeBytes: number;
  width?: number | undefined;
  height?: number | undefined;
  durationMs?: number | undefined;
  /** True when the client's declared type disagreed with the bytes. */
  declaredTypeMismatch: boolean;
}

export class MediaRejected extends ValidationError {
  constructor(reason: string, userMessage: string, context: Record<string, unknown> = {}) {
    super(reason, { userMessage, context });
  }
}

export async function verifyUploadedObject(input: VerificationInput): Promise<VerifiedMedia> {
  // ── 1. The object, and its real size ──────────────────────────────────────
  const head = await headObject(input.key);

  if (head.contentLength === 0) {
    throw new MediaRejected('Uploaded object is empty', 'That file is empty.');
  }

  // S3's byte count is authoritative; the declared size was only ever a hint.
  if (head.contentLength > input.maxBytes) {
    throw new MediaRejected(
      'Uploaded object exceeds the size limit',
      'That file is larger than the limit.',
      { sizeBytes: head.contentLength, maxBytes: input.maxBytes },
    );
  }

  // ── 2. What the bytes actually are ────────────────────────────────────────
  const prefixLength = Math.min(head.contentLength, SNIFF_PREFIX_BYTES) - 1;
  const prefix = await readRange(input.key, 0, Math.max(prefixLength, 0));

  let identified;
  try {
    identified = sniff(prefix);
  } catch (error) {
    const detail = error instanceof UnsupportedMediaError ? error.detected : undefined;
    throw new MediaRejected(
      `Rejected by content sniffing: ${(error as Error).message}`,
      detail
        ? `${detail} files can't be used as media.`
        : "That file isn't an image or video we can use.",
      { detected: detail, declared: input.declaredMimeType },
    );
  }

  // ── 3. Did the client tell the truth? ─────────────────────────────────────
  // Not fatal on its own — browsers guess badly — but it is recorded, and the
  // *sniffed* type is what gets stored and served either way.
  const declaredTypeMismatch = !declaredTypeMatches(input.declaredMimeType, identified.mimeType);

  // ── 4. Intrinsic properties ───────────────────────────────────────────────
  const probe = await probeIntrinsics(
    input.key,
    identified.mimeType,
    identified.kind,
    head.contentLength,
  );

  if (identified.kind === 'IMAGE' || identified.kind === 'GIF') {
    if (!probe.complete || !probe.width || !probe.height) {
      throw new MediaRejected(
        'Image dimensions could not be read',
        "That image appears to be damaged — we couldn't read its dimensions.",
        { mimeType: identified.mimeType },
      );
    }
  }

  if (identified.kind === 'VIDEO' && !probe.complete) {
    throw new MediaRejected(
      'Video metadata could not be read',
      "That video appears to be damaged — we couldn't read its length.",
      { mimeType: identified.mimeType },
    );
  }

  return {
    mimeType: identified.mimeType,
    kind: identified.kind,
    extension: identified.extension,
    sizeBytes: head.contentLength,
    width: probe.width,
    height: probe.height,
    durationMs: probe.durationMs,
    declaredTypeMismatch,
  };
}

/**
 * Read enough of the object to probe it.
 *
 * MP4 puts `moov` at the front when fast-started and at the end otherwise, so
 * a video reads both ends rather than the whole file — a 100MB upload is
 * verified with about 2MB of transfer.
 */
async function probeIntrinsics(
  key: string,
  mimeType: string,
  kind: MediaKind,
  size: number,
): Promise<MediaProbe> {
  if (kind === 'VIDEO') {
    const window = Math.min(VIDEO_PROBE_BYTES, size);
    const head = await readRange(key, 0, window - 1);

    const fromHead = probeMedia(mimeType, head);
    if (fromHead.complete) return fromHead;

    if (size > window) {
      const tail = await readRange(key, Math.max(size - window, 0), size - 1);
      const fromTail = probeMedia(mimeType, tail);
      if (fromTail.complete) return fromTail;
    }

    return fromHead;
  }

  const window = Math.min(IMAGE_PROBE_BYTES, size);
  return probeMedia(mimeType, await readRange(key, 0, window - 1));
}
