import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { serverEnv } from '@orbit/config';
import { InternalError, NotFoundError } from '@orbit/core';

/**
 * S3-compatible object storage (SRS §17, §51).
 *
 * Talks the S3 API, so AWS S3 in deployed environments and MinIO locally are
 * the same code path — which is what lets the media pipeline be tested against
 * real object storage rather than a stub.
 *
 * Two rules:
 *   • the bucket blocks all public access; every read is a short-lived signed
 *     URL issued only after an RBAC check;
 *   • uploads go browser → S3 directly, so a 100MB video never passes through
 *     a serverless function.
 */

let client: S3Client | undefined;

export function s3(): S3Client {
  if (client) return client;

  const env = serverEnv();
  client = new S3Client({
    region: env.S3_REGION,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
    // Set only for local S3-compatible storage; env validation forbids it in
    // production.
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });

  return client;
}

export function bucket(): string {
  return serverEnv().S3_BUCKET;
}

/** Test seam, so a suite can point at a throwaway bucket. */
export function resetS3(): void {
  client = undefined;
}

export interface PresignUploadInput {
  key: string;
  /** Declared type, echoed into the signature so the PUT must match it. */
  contentType: string;
  /** Hard ceiling, enforced by S3 rather than trusted from the client. */
  maxBytes: number;
  expiresInSeconds?: number;
}

/**
 * A presigned PUT for a direct browser upload.
 *
 * `ContentLength` is part of the signature, so a client cannot sign for a
 * small file and then send a large one — S3 rejects the mismatch. The byte
 * verification that follows the upload is what catches everything else.
 */
export async function presignUpload(
  input: PresignUploadInput & { contentLength: number },
): Promise<{ url: string; expiresAt: Date }> {
  if (input.contentLength > input.maxBytes) {
    throw new InternalError('Refusing to sign an upload above the limit');
  }

  const expiresIn = input.expiresInSeconds ?? 900;

  const url = await getSignedUrl(
    s3(),
    new PutObjectCommand({
      Bucket: bucket(),
      Key: input.key,
      ContentType: input.contentType,
      ContentLength: input.contentLength,
    }),
    { expiresIn },
  );

  return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
}

/**
 * A short-lived signed GET.
 *
 * `ResponseContentDisposition: attachment` and the *sniffed* content type are
 * forced into the response, so even a file that slipped through as something
 * unexpected is downloaded rather than rendered — a stored-XSS defence that
 * does not depend on the upload check being perfect.
 */
export async function presignDownload(input: {
  key: string;
  contentType: string;
  filename?: string | undefined;
  expiresInSeconds?: number;
  inline?: boolean;
}): Promise<{ url: string; expiresAt: Date }> {
  const expiresIn = input.expiresInSeconds ?? 900;
  const disposition = input.inline ? 'inline' : 'attachment';
  const filename = input.filename?.replace(/["\\]/g, '') ?? 'download';

  const url = await getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: input.key,
      ResponseContentType: input.contentType,
      ResponseContentDisposition: `${disposition}; filename="${filename}"`,
    }),
    { expiresIn },
  );

  return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
}

export interface ObjectHead {
  contentLength: number;
  contentType: string | undefined;
  etag: string | undefined;
  lastModified: Date | undefined;
}

export async function headObject(key: string): Promise<ObjectHead> {
  try {
    const result = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return {
      contentLength: result.ContentLength ?? 0,
      contentType: result.ContentType,
      etag: result.ETag,
      lastModified: result.LastModified,
    };
  } catch (error) {
    if (isNotFound(error)) {
      throw new NotFoundError('Uploaded file', {
        userMessage: 'The upload could not be found. Please try again.',
      });
    }
    throw error;
  }
}

/**
 * Read a byte range.
 *
 * Verification reads a prefix (and, for video, a suffix) rather than the whole
 * object, so checking a 100MB upload costs a few kilobytes of transfer.
 */
export async function readRange(key: string, start: number, end: number): Promise<Uint8Array> {
  const result = await s3().send(
    new GetObjectCommand({ Bucket: bucket(), Key: key, Range: `bytes=${start}-${end}` }),
  );

  const body = result.Body;
  if (!body) throw new InternalError('Object body was empty');

  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);

  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Write bytes from the server.
 *
 * Uploads from a browser go through `presignUpload` so the bytes never touch
 * our infrastructure. This is the other case: something we generated
 * ourselves — a rendered report — where there is no client to sign a URL for
 * and the content is already in hand.
 *
 * `ContentType` and `ContentDisposition` are set here rather than left to the
 * reader, so a stored object cannot be served as something it is not.
 */
export async function putObject(input: {
  key: string;
  body: Uint8Array | string;
  contentType: string;
  filename?: string | undefined;
}): Promise<{ sizeBytes: number }> {
  const body = typeof input.body === 'string' ? new TextEncoder().encode(input.body) : input.body;
  const filename = input.filename?.replace(/["\\]/g, '');

  await s3().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: input.key,
      Body: body,
      ContentType: input.contentType,
      ...(filename ? { ContentDisposition: `attachment; filename="${filename}"` } : {}),
    }),
  );

  return { sizeBytes: body.byteLength };
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

export async function deleteObjects(keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;

  // S3 caps a batch delete at 1000 keys.
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await s3().send(
      new DeleteObjectsCommand({
        Bucket: bucket(),
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
    );
  }
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string }).name;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === 'NotFound' || name === 'NoSuchKey' || status === 404;
}
