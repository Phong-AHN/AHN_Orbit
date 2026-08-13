'use client';

import { apiRequest } from '@/features/posts/ui/api';

/**
 * Browser-side media upload.
 *
 * Three steps, and the middle one does not go through our server at all:
 *
 *   1. `presign` — reserve an asset row and get a signed PUT
 *   2. `PUT` the bytes straight to S3
 *   3. `complete` — the server reads the object back and verifies it
 *
 * Bytes never pass through the application. That is what keeps a 100 MB video
 * off a serverless function with a request-size ceiling, and it is why the
 * verification in step 3 exists: the server never saw the upload, so it has to
 * go and look. Everything the browser claims — type, size, filename — is
 * re-derived from the object itself (docs/SECURITY.md §8).
 */

export interface PresignedUpload {
  assetId: string;
  uploadUrl: string;
  expiresAt: string;
  storageKey: string;
}

export interface MediaAsset {
  id: string;
  kind: 'IMAGE' | 'VIDEO' | 'GIF';
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  status: string;
  originalFilename: string | null;
}

const base = (orgSlug: string) => `/api/v1/orgs/${encodeURIComponent(orgSlug)}/media`;

export function presignUpload(
  orgSlug: string,
  input: {
    workspaceId: string;
    brandId?: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
  },
) {
  return apiRequest<PresignedUpload>(`${base(orgSlug)}/presign`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function completeUpload(orgSlug: string, assetId: string) {
  return apiRequest<{ asset: MediaAsset }>(`${base(orgSlug)}/${assetId}/complete`, {
    method: 'POST',
  });
}

/** A short-lived signed GET, for showing the file back to the person who sent it. */
export function viewUrl(orgSlug: string, assetId: string) {
  return apiRequest<{ url: string; expiresAt: string }>(
    `${base(orgSlug)}/${assetId}/url?inline=true`,
  );
}

/**
 * Send the bytes to S3.
 *
 * `content-type` and `content-length` are part of the signature, so they have
 * to match what `presign` was told — S3 rejects the mismatch, which is exactly
 * the point: a client cannot sign for a small JPEG and then send a large
 * something-else.
 */
export async function putToStorage(uploadUrl: string, file: File): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': file.type, 'content-length': String(file.size) },
    body: file,
  });

  if (!response.ok) {
    // A CORS failure surfaces as a TypeError before this line, so reaching here
    // means S3 answered and refused.
    throw new Error(`Storage rejected the upload (${response.status}).`);
  }
}
