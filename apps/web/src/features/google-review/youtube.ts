/**
 * The YouTube calls the review page makes, one per scope it demonstrates.
 *
 * - `youtube.readonly`: list the signed-in account's channels, and the channel's
 *   recent uploads with their counters — what Orbit uses to show which channel
 *   a client connected and how a published video is doing.
 * - `youtube.upload`: upload one video — what Orbit uses to publish a client's
 *   scheduled video.
 *
 * Direct, minimal `fetch` calls rather than the adapter's publish path, because
 * that path reads media from storage and records attempts against a tenant —
 * neither of which exists here. The scopes are the adapter's own.
 */

const API = 'https://www.googleapis.com';

export interface ReviewChannel {
  id: string;
  title: string;
  handle: string | null;
  uploadsPlaylistId: string | null;
}

export interface ReviewVideo {
  id: string;
  title: string;
  publishedAt: string | null;
  privacyStatus: string | null;
  viewCount: string | null;
}

async function google<T>(url: string, accessToken: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${accessToken}`, ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: { message?: string; errors?: Array<{ reason?: string }> };
  };
  if (!response.ok) {
    const reason = body.error?.errors?.[0]?.reason;
    throw new Error(`YouTube ${response.status}${reason ? ` (${reason})` : ''}`);
  }
  return body;
}

/** `youtube.readonly`: the channels this Google account owns. */
export async function listChannels(accessToken: string): Promise<ReviewChannel[]> {
  const body = await google<{
    items?: Array<{
      id?: string;
      snippet?: { title?: string; customUrl?: string };
      contentDetails?: { relatedPlaylists?: { uploads?: string } };
    }>;
  }>(`${API}/youtube/v3/channels?part=snippet,contentDetails&mine=true&maxResults=50`, accessToken);

  return (body.items ?? [])
    .filter((item) => item.id)
    .map((item) => ({
      id: item.id as string,
      title: item.snippet?.title ?? (item.id as string),
      handle: item.snippet?.customUrl ?? null,
      uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null,
    }));
}

/** `youtube.readonly`: the channel's latest uploads, with their view counts. */
export async function listRecentUploads(
  accessToken: string,
  uploadsPlaylistId: string,
): Promise<ReviewVideo[]> {
  const playlist = await google<{
    items?: Array<{ contentDetails?: { videoId?: string } }>;
  }>(
    `${API}/youtube/v3/playlistItems?part=contentDetails&maxResults=5&playlistId=${encodeURIComponent(uploadsPlaylistId)}`,
    accessToken,
  );
  const ids = (playlist.items ?? [])
    .map((item) => item.contentDetails?.videoId)
    .filter((id): id is string => Boolean(id));
  if (ids.length === 0) return [];

  const videos = await google<{
    items?: Array<{
      id?: string;
      snippet?: { title?: string; publishedAt?: string };
      status?: { privacyStatus?: string };
      statistics?: { viewCount?: string };
    }>;
  }>(`${API}/youtube/v3/videos?part=snippet,status,statistics&id=${ids.join(',')}`, accessToken);

  return (videos.items ?? []).map((video) => ({
    id: video.id ?? '',
    title: video.snippet?.title ?? '',
    publishedAt: video.snippet?.publishedAt ?? null,
    privacyStatus: video.status?.privacyStatus ?? null,
    viewCount: video.statistics?.viewCount ?? null,
  }));
}

/**
 * `youtube.upload`: one video, as Orbit publishes one — a resumable session,
 * then the bytes. Private by default, and the made-for-kids declaration is
 * the reviewer's to make, exactly as it is an agency's in the product.
 */
export async function uploadVideo(
  accessToken: string,
  input: {
    title: string;
    description: string;
    privacyStatus: 'private' | 'unlisted' | 'public';
    madeForKids: boolean;
    /** The video, as the browser sent it. */
    file: Blob;
  },
): Promise<{ videoId: string }> {
  const session = await fetch(
    `${API}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'x-upload-content-type': input.file.type,
        'x-upload-content-length': String(input.file.size),
      },
      body: JSON.stringify({
        snippet: { title: input.title, description: input.description },
        status: { privacyStatus: input.privacyStatus, selfDeclaredMadeForKids: input.madeForKids },
      }),
    },
  );
  const location = session.headers.get('location');
  if (!session.ok || !location) {
    throw new Error(`YouTube refused to open an upload session (${session.status})`);
  }

  const uploaded = await fetch(location, {
    method: 'PUT',
    headers: {
      'content-type': input.file.type,
      'content-length': String(input.file.size),
    },
    body: input.file,
  });
  const body = (await uploaded.json().catch(() => ({}))) as { id?: string };
  if (!uploaded.ok || !body.id)
    throw new Error(`YouTube did not accept the upload (${uploaded.status})`);
  return { videoId: body.id };
}

/** Give the token back. Best effort: an expired token is already worthless. */
export async function revokeToken(accessToken: string): Promise<void> {
  await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: accessToken }).toString(),
  }).catch(() => undefined);
}
