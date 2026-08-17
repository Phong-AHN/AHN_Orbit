/**
 * Intrinsic media properties, read from the bytes.
 *
 * Dimensions and duration decide whether a post can be published at all
 * (aspect-ratio bounds, video length limits), so taking them from a client is
 * the same mistake as taking the MIME type from one — it would let an upload
 * claim a shape it does not have and fail at the platform instead of at the
 * door.
 *
 * These are header parsers, not decoders: they read structure, never pixel
 * data, so a malformed body cannot turn into a decode bomb.
 */

export interface MediaProbe {
  width?: number | undefined;
  height?: number | undefined;
  durationMs?: number | undefined;
  /**
   * Average frames per second of the video track.
   *
   * Read from the sample table rather than believed from a header, because the
   * header is what lies: a phone records **variable frame rate** and labels the
   * file 30fps while the actual gaps between frames vary. TikTok reads the real
   * gaps and refuses the file, which is how a video "at 30fps" is rejected for
   * `frame_rate_check_failed`.
   */
  frameRate?: number | undefined;
  /**
   * The highest instantaneous rate, from the shortest gap between two frames.
   *
   * On a constant-rate file this equals `frameRate`. On a variable-rate one it
   * is higher — sometimes far higher — and it is the number platforms object
   * to, so it is the one worth checking against a ceiling.
   */
  peakFrameRate?: number | undefined;
  /** True when the frame gaps are not all identical. */
  variableFrameRate?: boolean | undefined;
  /** True when the parser found the fields it expected. */
  complete: boolean;
}

// ── Images ──────────────────────────────────────────────────────────────────

function probePng(bytes: Uint8Array): MediaProbe {
  // IHDR is always the first chunk: 8-byte signature, 4-byte length, "IHDR",
  // then width and height as big-endian uint32.
  if (bytes.length < 24) return { complete: false };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20), complete: true };
}

function probeGif(bytes: Uint8Array): MediaProbe {
  if (bytes.length < 10) return { complete: false };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Logical screen descriptor, little-endian.
  return { width: view.getUint16(6, true), height: view.getUint16(8, true), complete: true };
}

function probeJpeg(bytes: Uint8Array): MediaProbe {
  // Walk the segment chain looking for a Start-Of-Frame marker, which is the
  // only place the true dimensions live. EXIF may claim otherwise and is not
  // trusted.
  let offset = 2;

  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }

    const marker = bytes[offset + 1]!;

    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    // SOF0–SOF15, excluding DHT (c4), JPG (c8) and DAC (cc), which are not frames.
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint16(offset + 2);

    if (isFrame) {
      // [marker][length:2][precision:1][height:2][width:2]
      return {
        height: view.getUint16(offset + 5),
        width: view.getUint16(offset + 7),
        complete: true,
      };
    }

    if (length < 2) return { complete: false };
    offset += 2 + length;
  }

  return { complete: false };
}

function probeWebp(bytes: Uint8Array): MediaProbe {
  if (bytes.length < 30) return { complete: false };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);

  // Lossy: VP8 bitstream, dimensions 14 bytes in as 14-bit values.
  if (format === 'VP8 ') {
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
      complete: true,
    };
  }

  // Lossless: VP8L packs 14-bit width-1 and height-1 into 32 bits.
  if (format === 'VP8L') {
    const bits = view.getUint32(21, true);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
      complete: true,
    };
  }

  // Extended: VP8X stores canvas size as 24-bit width-1 and height-1.
  if (format === 'VP8X') {
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    return { width, height, complete: true };
  }

  return { complete: false };
}

// ── Video ───────────────────────────────────────────────────────────────────

/**
 * MP4/QuickTime duration and dimensions.
 *
 * Walks the ISO base-media box tree to `moov`, then reads `mvhd` for duration
 * and the first video `tkhd` for display dimensions. Box traversal is depth-
 * and iteration-bounded, so a hostile file cannot spin the parser.
 */
function probeMp4(bytes: Uint8Array): MediaProbe {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: MediaProbe = { complete: false };

  /** The track currently being walked, so its boxes are read together. */
  let track: TrackParts | undefined;

  const walk = (start: number, end: number, depth: number): void => {
    // moov → trak → mdia → minf → stbl → stts is six levels; the old limit of
    // five stopped exactly one box short of the sample table.
    if (depth > 6) return;
    let offset = start;
    let iterations = 0;

    while (offset + 8 <= end && iterations++ < 1000) {
      const size = view.getUint32(offset);
      const type = String.fromCharCode(
        bytes[offset + 4]!,
        bytes[offset + 5]!,
        bytes[offset + 6]!,
        bytes[offset + 7]!,
      );

      // size 0 means "to end of file"; size 1 means a 64-bit size follows.
      const boxEnd = size === 0 ? end : size === 1 ? end : offset + size;
      if (size !== 0 && size !== 1 && size < 8) return;

      if (type === 'trak') {
        // A file has one trak per track. Frame rate belongs to the video one,
        // and a sound track has its own sample table with a completely
        // different rate — reading the wrong one gives a plausible, wrong
        // number rather than an obvious failure.
        track = { isVideo: false };
        walk(offset + 8, Math.min(boxEnd, end), depth + 1);
        if (track.isVideo) applyTrack(result, track);
        track = undefined;
      } else if (type === 'moov' || type === 'mdia' || type === 'minf' || type === 'stbl') {
        walk(offset + 8, Math.min(boxEnd, end), depth + 1);
      } else if (type === 'hdlr' && track && offset + 24 <= end) {
        // handler_type sits 8 bytes past the version/flags and predefined field.
        track.isVideo =
          String.fromCharCode(
            bytes[offset + 16]!,
            bytes[offset + 17]!,
            bytes[offset + 18]!,
            bytes[offset + 19]!,
          ) === 'vide';
      } else if (type === 'mdhd' && track && offset + 24 <= end) {
        // Same layout as mvhd: the version widens the three time fields.
        const version = bytes[offset + 8]!;
        track.timescale = version === 1 ? view.getUint32(offset + 28) : view.getUint32(offset + 20);
      } else if (type === 'stts' && track) {
        track.samples = readTimeToSample(view, bytes, offset, Math.min(boxEnd, end));
      } else if (type === 'mvhd' && offset + 32 <= end) {
        const version = bytes[offset + 8]!;
        const timescale = version === 1 ? view.getUint32(offset + 28) : view.getUint32(offset + 20);
        const duration =
          version === 1 ? Number(view.getBigUint64(offset + 32)) : view.getUint32(offset + 24);

        if (timescale > 0) {
          result.durationMs = Math.round((duration / timescale) * 1000);
        }
      } else if (type === 'tkhd' && offset + 92 <= end && result.width === undefined) {
        // tkhd v0 is 92 bytes with width at 84 and height at 88; v1 widens the
        // three time fields by 12 bytes, moving them to 96 and 100.
        const version = bytes[offset + 8]!;
        const base = version === 1 ? offset + 96 : offset + 84;
        if (base + 8 <= end) {
          // Fixed-point 16.16 display width and height.
          const width = view.getUint32(base) / 65_536;
          const height = view.getUint32(base + 4) / 65_536;
          // A sound track has zero dimensions; skip it and keep looking.
          if (width > 0 && height > 0) {
            result.width = Math.round(width);
            result.height = Math.round(height);
          }
        }
      }

      if (boxEnd <= offset) return;
      offset = boxEnd;
    }
  };

  walk(0, bytes.length, 0);

  /**
   * Second attempt, for a slice that does not start on a box boundary.
   *
   * The walk above assumes byte 0 begins a box. That holds for the head of a
   * file and **never** holds for a tail slice, which starts wherever
   * `size - window` happens to land — so the first four bytes read as a
   * nonsense box size and traversal stops immediately.
   *
   * That mattered: an MP4 with `moov` at the end is not unusual, it is what a
   * phone or an editor produces unless fast-start was applied. Every one of
   * them was reported as a damaged file that we could not read the length of.
   *
   * So when the aligned walk finds nothing, locate `moov` by its signature and
   * walk from the box that contains it.
   */
  if (result.durationMs === undefined) {
    const moovStart = findBoxStart(bytes, 'moov');
    if (moovStart !== undefined) walk(moovStart, bytes.length, 0);
  }

  result.complete = result.durationMs !== undefined;
  return result;
}

/** What a single track contributes, gathered while its boxes are walked. */
interface TrackParts {
  isVideo: boolean;
  timescale?: number | undefined;
  samples?: { count: number; totalDelta: number; minDelta: number; deltas: number } | undefined;
}

/**
 * Read `stts`, the table that says how long each frame is held.
 *
 * It is a run-length list: `(sample_count, sample_delta)` pairs in the track's
 * own timescale. A **constant** frame rate is one entry; more than one distinct
 * delta means the gaps vary, which is what "variable frame rate" is.
 *
 * Bounded by the box and by the buffer — a truncated tail slice yields a partial
 * table, and a partial average is still a usable answer, so it is not refused.
 */
function readTimeToSample(
  view: DataView,
  bytes: Uint8Array,
  boxStart: number,
  end: number,
): TrackParts['samples'] {
  // 8 header + 1 version + 3 flags + 4 entry_count.
  let offset = boxStart + 16;
  if (offset > end) return undefined;

  const declared = view.getUint32(boxStart + 12);
  // The buffer caps the count: never trust a length field to size a loop.
  const entries = Math.min(declared, Math.floor((end - offset) / 8));

  let count = 0;
  let totalDelta = 0;
  let minDelta = Number.POSITIVE_INFINITY;
  const seen = new Set<number>();

  for (let i = 0; i < entries; i += 1) {
    const sampleCount = view.getUint32(offset);
    const sampleDelta = view.getUint32(offset + 4);
    offset += 8;

    // A zero delta is not a frame duration; skip it rather than dividing by it.
    if (sampleDelta === 0 || sampleCount === 0) continue;

    count += sampleCount;
    totalDelta += sampleCount * sampleDelta;
    minDelta = Math.min(minDelta, sampleDelta);
    seen.add(sampleDelta);
  }

  void bytes;
  if (count === 0 || !Number.isFinite(minDelta)) return undefined;

  return { count, totalDelta, minDelta, deltas: seen.size };
}

/** Fold a finished video track's numbers into the result. */
function applyTrack(result: MediaProbe, track: TrackParts): void {
  const { timescale, samples } = track;
  if (!timescale || timescale <= 0 || !samples) return;

  const averageDelta = samples.totalDelta / samples.count;
  if (averageDelta <= 0) return;

  result.frameRate = round2(timescale / averageDelta);
  result.peakFrameRate = round2(timescale / samples.minDelta);
  // One distinct gap is a constant rate; anything else varies.
  result.variableFrameRate = samples.deltas > 1;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Find where a named box starts, without assuming alignment.
 *
 * An ISO-BMFF box header is a 4-byte big-endian size followed by a 4-byte
 * ASCII type, so the type appears four bytes into its own box. Scanning for the
 * type and stepping back four is the only way to re-synchronise on a slice that
 * begins mid-file.
 *
 * The size is checked rather than trusted: the four characters could occur
 * inside compressed video data by chance, and a candidate whose declared size
 * is impossible is a false positive rather than a box. Bounded by the buffer
 * length, so a hostile file cannot spin this.
 */
function findBoxStart(bytes: Uint8Array, type: string): number | undefined {
  const [a, b, c, d] = [
    type.charCodeAt(0),
    type.charCodeAt(1),
    type.charCodeAt(2),
    type.charCodeAt(3),
  ];

  for (let i = 4; i + 4 <= bytes.length; i += 1) {
    if (bytes[i] !== a || bytes[i + 1] !== b || bytes[i + 2] !== c || bytes[i + 3] !== d) continue;

    const start = i - 4;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = view.getUint32(start);

    // 0 means "to end of file" and 1 means a 64-bit size follows; both are
    // legitimate. Anything else must be at least a header long.
    if (size === 0 || size === 1 || size >= 8) return start;
  }

  return undefined;
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Bytes a probe needs.
 *
 * Images announce their size in the first few kilobytes. MP4 puts `moov`
 * either at the front (fast-start) or at the very end, so a video probe reads
 * both ends rather than the whole file.
 */
export const IMAGE_PROBE_BYTES = 64 * 1024;
export const VIDEO_PROBE_BYTES = 1024 * 1024;

export function probeMedia(mimeType: string, bytes: Uint8Array): MediaProbe {
  try {
    switch (mimeType) {
      case 'image/png':
        return probePng(bytes);
      case 'image/gif':
        return probeGif(bytes);
      case 'image/jpeg':
        return probeJpeg(bytes);
      case 'image/webp':
        return probeWebp(bytes);
      case 'video/mp4':
      case 'video/quicktime':
        return probeMp4(bytes);
      default:
        return { complete: false };
    }
  } catch {
    // A truncated or malformed header is a validation failure, not a crash.
    return { complete: false };
  }
}
