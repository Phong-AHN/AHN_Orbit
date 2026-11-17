import type sharpType from 'sharp';
import { headObject, putObject, readObject } from './s3.js';

/**
 * Converting an image to a format a platform accepts (**D-125**).
 *
 * Instagram takes JPEG only and TikTok's photo posts JPEG or WebP, while
 * people upload PNG — screenshots, exports from design tools, anything with
 * transparency. Rather than refuse those, the worker publishes a converted
 * copy, written once beside the original and reused after that.
 */

export interface ImageConversionOptions {
  /** Target format, default 'jpeg' */
  format?: 'jpeg' | 'png' | 'webp';
  /** JPEG/WebP quality 1-100, default 85 */
  quality?: number;
  /** Solid background color to flatten transparent alpha channel onto (default '#ffffff') */
  backgroundColor?: string;
  /** Max dimension (width or height) to resize to, preserving aspect ratio */
  maxDimension?: number;
}

export interface ConvertedImage {
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
  width: number;
  height: number;
  sizeBytes: number;
}

/** The derivatives `ensureConvertedImage` writes, by format: variant name and extension. */
const DERIVATIVES = {
  jpeg: { variant: 'converted-jpeg', extension: 'jpg' },
  png: { variant: 'converted-png', extension: 'png' },
} as const;

/**
 * Derives a secondary storage key for converted image variants.
 *
 * e.g. 'org/.../original.png' -> 'org/.../converted-jpeg.jpg'
 *
 * Every asset has a folder of its own (`…/<assetId>/original.<ext>`, see
 * keys.ts), so a derivative cannot collide with another asset's, and it stays
 * under the same tenant prefix as the original.
 */
export function getDerivedStorageKey(
  originalKey: string,
  variant: string,
  extension: string,
): string {
  const lastSlash = originalKey.lastIndexOf('/');
  if (lastSlash === -1) {
    return `${variant}.${extension}`;
  }
  return `${originalKey.slice(0, lastSlash)}/${variant}.${extension}`;
}

/**
 * Every derivative that may exist for an original.
 *
 * Whatever deletes the original deletes these too: a converted copy is the
 * client's image all the same, and it must not outlive the file they deleted.
 * Deleting a key that was never written is harmless.
 */
export function derivedImageKeys(originalKey: string): string[] {
  return Object.values(DERIVATIVES).map(({ variant, extension }) =>
    getDerivedStorageKey(originalKey, variant, extension),
  );
}

type Sharp = typeof sharpType;
let sharpModule: Promise<Sharp> | undefined;

/**
 * Loaded on first use, not at import: most of what imports this package never
 * touches an image, and libvips is a large native module to load for nothing.
 * The specifier is static so the web bundler and Vercel's file tracing both
 * see it — a computed one is invisible to them and fails only in production.
 */
function loadSharp(): Promise<Sharp> {
  sharpModule ??= import('sharp').then((mod) => mod.default);
  return sharpModule;
}

/**
 * Converts an image to the target format required by social platforms.
 *
 * Platform publishing best practices applied:
 * 1. Auto-rotates according to EXIF orientation tags (.rotate()).
 * 2. Flattens transparent alpha channels onto a solid background (default '#ffffff')
 *    so transparent areas never turn black in JPEG.
 * 3. Enforces sRGB colorspace for standard display across social platforms.
 * 4. High-efficiency encoding (mozjpeg for JPEG).
 */
export async function convertImage(
  inputBytes: Uint8Array | Buffer,
  options: ImageConversionOptions = {},
): Promise<ConvertedImage> {
  const sharp = await loadSharp();
  const format = options.format ?? 'jpeg';
  const quality = options.quality ?? 85;
  const background = options.backgroundColor ?? '#ffffff';

  let pipeline = sharp(inputBytes).rotate();

  if (options.maxDimension) {
    pipeline = pipeline.resize(options.maxDimension, options.maxDimension, {
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  if (format === 'jpeg') {
    pipeline = pipeline
      .flatten({ background })
      .toColorspace('srgb')
      .jpeg({ quality, mozjpeg: true });
  } else if (format === 'png') {
    pipeline = pipeline.png({ compressionLevel: 9 });
  } else {
    pipeline = pipeline.webp({ quality });
  }

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

  const mimeType = format === 'jpeg' ? 'image/jpeg' : format === 'png' ? 'image/png' : 'image/webp';
  const extension = format === 'jpeg' ? 'jpg' : format;

  return {
    bytes: new Uint8Array(data),
    mimeType,
    extension,
    width: info.width,
    height: info.height,
    sizeBytes: data.byteLength,
  };
}

/**
 * Ensures an image variant exists in storage matching the target platform format.
 * Checks for a cached derivative first; if absent, reads original, converts, and uploads it.
 */
export async function ensureConvertedImage(input: {
  storageKey: string;
  targetMimeType?: string;
  quality?: number;
}): Promise<{
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
}> {
  const targetFormat = input.targetMimeType === 'image/png' ? 'png' : 'jpeg';
  const { variant, extension } = DERIVATIVES[targetFormat];
  const mimeType = targetFormat === 'png' ? 'image/png' : 'image/jpeg';
  const derivedKey = getDerivedStorageKey(input.storageKey, variant, extension);

  // Converted on an earlier publish, or at upload: reuse it.
  try {
    const head = await headObject(derivedKey);
    if (head.contentLength > 0) {
      return { storageKey: derivedKey, mimeType, sizeBytes: head.contentLength };
    }
  } catch {
    // Not there yet (or unreadable): convert below, which rewrites it.
  }

  const originalBytes = await readObject(input.storageKey);
  const converted = await convertImage(originalBytes, {
    format: targetFormat,
    quality: input.quality ?? 85,
  });

  await putObject({
    key: derivedKey,
    body: converted.bytes,
    contentType: converted.mimeType,
  });

  return {
    storageKey: derivedKey,
    mimeType: converted.mimeType,
    sizeBytes: converted.sizeBytes,
    width: converted.width,
    height: converted.height,
  };
}
