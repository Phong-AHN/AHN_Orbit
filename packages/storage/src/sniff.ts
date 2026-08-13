import type { MediaKind } from '@orbit/core';

/**
 * File type detection from the actual bytes (SRS §17).
 *
 * A client-declared MIME type and a filename extension are *assertions*, not
 * facts. `evil.php` renamed to `cat.jpg` and uploaded with
 * `Content-Type: image/jpeg` is trivially easy; the only thing that cannot be
 * lied about is the leading bytes of the file.
 *
 * Everything here reads a small prefix — 64 bytes is enough for every format
 * we accept — so verification does not require holding a 100MB video in memory.
 */

export interface SniffResult {
  /** The MIME type the bytes actually are. */
  mimeType: string;
  kind: MediaKind;
  /** Canonical extension for the detected type. Never taken from the upload. */
  extension: string;
}

/** Types we are willing to store at all, regardless of what a platform accepts. */
const SIGNATURES: ReadonlyArray<{
  mimeType: string;
  kind: MediaKind;
  extension: string;
  test: (bytes: Uint8Array) => boolean;
}> = [
  {
    mimeType: 'image/jpeg',
    kind: 'IMAGE',
    extension: 'jpg',
    test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mimeType: 'image/png',
    kind: 'IMAGE',
    extension: 'png',
    test: (b) =>
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    // GIF is classed as its own kind: platforms treat animated GIFs
    // differently from stills, and the capability layer needs to tell them
    // apart.
    mimeType: 'image/gif',
    kind: 'GIF',
    extension: 'gif',
    test: (b) =>
      b[0] === 0x47 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) &&
      b[5] === 0x61,
  },
  {
    mimeType: 'image/webp',
    kind: 'IMAGE',
    extension: 'webp',
    test: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP',
  },
  {
    mimeType: 'video/mp4',
    kind: 'VIDEO',
    extension: 'mp4',
    test: (b) => ascii(b, 4, 4) === 'ftyp' && isMp4Brand(ascii(b, 8, 4)),
  },
  {
    mimeType: 'video/quicktime',
    kind: 'VIDEO',
    extension: 'mov',
    test: (b) => ascii(b, 4, 4) === 'ftyp' && ascii(b, 8, 4) === 'qt  ',
  },
];

/** ftyp brands we accept as MP4. `qt  ` is handled separately as QuickTime. */
const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'M4V ',
  'M4A ',
  'dash',
  'mmp4',
]);

function isMp4Brand(brand: string): boolean {
  return MP4_BRANDS.has(brand);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    const byte = bytes[offset + i];
    if (byte === undefined) return '';
    out += String.fromCharCode(byte);
  }
  return out;
}

/**
 * Content that must never be stored, even if a caller insists.
 *
 * SVG is the notable one: it is an image to a user and a script host to a
 * browser, so serving one from a URL a client visits is stored XSS. We reject
 * it rather than trying to sanitise it (SRS §17: prevent arbitrary file
 * execution).
 */
const FORBIDDEN: ReadonlyArray<{ label: string; test: (prefix: string) => boolean }> = [
  { label: 'SVG', test: (p) => /^\s*(<\?xml[^>]*\?>\s*)?(<!--.*?-->\s*)*<svg[\s>]/i.test(p) },
  {
    label: 'HTML',
    test: (p) => /^\s*(<!doctype\s+html|<html[\s>]|<head[\s>]|<script[\s>])/i.test(p),
  },
  { label: 'Windows executable', test: (p) => p.startsWith('MZ') },
  { label: 'ELF executable', test: (p) => p.charCodeAt(0) === 0x7f && p.slice(1, 4) === 'ELF' },
  { label: 'Shell script', test: (p) => p.startsWith('#!') },
  // A ZIP container could be a docx, a jar, or anything else. None are media.
  { label: 'Archive', test: (p) => p.startsWith('PK\x03\x04') },
];

export class UnsupportedMediaError extends Error {
  constructor(
    readonly detail: string,
    readonly detected: string | undefined,
  ) {
    super(detail);
    this.name = 'UnsupportedMediaError';
  }
}

/**
 * Identify a file from its leading bytes.
 *
 * Throws for anything not on the accept list. The default is refusal: a format
 * we do not recognise is not stored, rather than stored and hoped about.
 */
export function sniff(prefix: Uint8Array): SniffResult {
  const asText = ascii(prefix, 0, Math.min(prefix.length, 64));

  for (const forbidden of FORBIDDEN) {
    if (forbidden.test(asText)) {
      throw new UnsupportedMediaError(
        `${forbidden.label} content is not accepted as media`,
        forbidden.label,
      );
    }
  }

  for (const signature of SIGNATURES) {
    if (signature.test(prefix)) {
      return {
        mimeType: signature.mimeType,
        kind: signature.kind,
        extension: signature.extension,
      };
    }
  }

  throw new UnsupportedMediaError('File type could not be identified from its contents', undefined);
}

/** Non-throwing variant, for callers that treat "unknown" as a normal outcome. */
export function trySniff(prefix: Uint8Array): SniffResult | undefined {
  try {
    return sniff(prefix);
  } catch {
    return undefined;
  }
}

/**
 * Whether a client's declared type matches reality.
 *
 * Used to distinguish an honest mistake (a browser guessing `application/
 * octet-stream`) from a deliberate mismatch worth logging as a security event.
 */
export function declaredTypeMatches(declared: string | undefined, actual: string): boolean {
  if (!declared) return false;
  const normalised = declared.split(';')[0]?.trim().toLowerCase() ?? '';
  if (normalised === actual) return true;
  // Browsers and older clients use these interchangeably.
  if (normalised === 'image/jpg' && actual === 'image/jpeg') return true;
  return false;
}

/** Bytes needed to identify any accepted format. */
export const SNIFF_PREFIX_BYTES = 64;
