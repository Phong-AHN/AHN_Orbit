import { serverEnv } from '@orbit/config';

/**
 * The TikTok calls the review page makes with the reviewer's own token — the
 * same endpoints the product's TikTok adapter calls, each demonstrating one
 * scope: `user/info` (user.info.basic, user.info.profile), `creator_info` and
 * `video/init` + upload + `status/fetch` (video.publish), `video/list`
 * (video.list).
 */

const API = 'https://open.tiktokapis.com';

interface Envelope<T> {
  data?: T;
  error?: { code?: string; message?: string };
}

async function call<T>(
  path: string,
  token: string,
  init: { method: 'GET' | 'POST'; json?: unknown },
) {
  const response = await fetch(`${API}${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.json !== undefined ? { 'content-type': 'application/json; charset=UTF-8' } : {}),
    },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => ({}))) as Envelope<T>;
  // TikTok reports success as error.code "ok", and some failures with HTTP 200.
  if (!response.ok || (body.error?.code && body.error.code !== 'ok')) {
    throw new Error(
      body.error?.message || body.error?.code || `TikTok returned ${response.status}`,
    );
  }
  return (body.data ?? {}) as T;
}

export interface TikTokUser {
  openId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
}

export async function getUser(token: string): Promise<TikTokUser> {
  const data = await call<{
    user?: { open_id?: string; display_name?: string; username?: string; avatar_url?: string };
  }>('/v2/user/info/?fields=open_id,avatar_url,display_name,username', token, { method: 'GET' });
  return {
    openId: data.user?.open_id ?? '',
    displayName: data.user?.display_name ?? 'TikTok account',
    username: data.user?.username ?? null,
    avatarUrl: data.user?.avatar_url ?? null,
  };
}

export interface CreatorInfo {
  nickname: string;
  username: string;
  avatarUrl: string | null;
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number;
}

export async function getCreatorInfo(token: string): Promise<CreatorInfo> {
  const data = await call<{
    creator_nickname?: string;
    creator_username?: string;
    creator_avatar_url?: string;
    privacy_level_options?: string[];
    comment_disabled?: boolean;
    duet_disabled?: boolean;
    stitch_disabled?: boolean;
    max_video_post_duration_sec?: number;
  }>('/v2/post/publish/creator_info/query/', token, { method: 'POST', json: {} });
  return {
    nickname: data.creator_nickname ?? '',
    username: data.creator_username ?? '',
    avatarUrl: data.creator_avatar_url ?? null,
    privacyLevelOptions: data.privacy_level_options ?? [],
    commentDisabled: data.comment_disabled ?? false,
    duetDisabled: data.duet_disabled ?? false,
    stitchDisabled: data.stitch_disabled ?? false,
    maxVideoPostDurationSec: data.max_video_post_duration_sec ?? 0,
  };
}

export interface DirectPost {
  title: string;
  privacyLevel: string;
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  brandContent: boolean;
  brandOrganic: boolean;
}

/** Direct Post with FILE_UPLOAD in one chunk: init, then PUT the bytes. */
export async function postVideo(token: string, post: DirectPost, file: Blob): Promise<string> {
  const size = file.size;
  const init = await call<{ publish_id?: string; upload_url?: string }>(
    '/v2/post/publish/video/init/',
    token,
    {
      method: 'POST',
      json: {
        post_info: {
          title: post.title,
          privacy_level: post.privacyLevel,
          disable_comment: post.disableComment,
          disable_duet: post.disableDuet,
          disable_stitch: post.disableStitch,
          brand_content_toggle: post.brandContent,
          brand_organic_toggle: post.brandOrganic,
        },
        // A file under 5 MB is sent whole: one chunk the size of the file.
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: size,
          chunk_size: size,
          total_chunk_count: 1,
        },
      },
    },
  );
  if (!init.publish_id || !init.upload_url) throw new Error('TikTok did not return an upload URL');

  const upload = await fetch(init.upload_url, {
    method: 'PUT',
    headers: {
      'content-type': file.type || 'video/mp4',
      'content-length': String(size),
      'content-range': `bytes 0-${size - 1}/${size}`,
    },
    body: new Uint8Array(await file.arrayBuffer()),
    signal: AbortSignal.timeout(60_000),
  });
  if (![200, 201, 206].includes(upload.status)) {
    throw new Error(`The video upload was refused (HTTP ${upload.status})`);
  }
  return init.publish_id;
}

export async function getPublishStatus(token: string, publishId: string) {
  const data = await call<{ status?: string; fail_reason?: string }>(
    '/v2/post/publish/status/fetch/',
    token,
    { method: 'POST', json: { publish_id: publishId } },
  );
  return { status: data.status ?? 'UNKNOWN', failReason: data.fail_reason ?? null };
}

export interface TikTokVideo {
  id: string;
  title: string;
  shareUrl: string | null;
  createdAt: number | null;
  viewCount: number | null;
  likeCount: number | null;
}

export async function listVideos(token: string): Promise<TikTokVideo[]> {
  const data = await call<{
    videos?: Array<{
      id?: string;
      title?: string;
      share_url?: string;
      create_time?: number;
      view_count?: number;
      like_count?: number;
    }>;
  }>('/v2/video/list/?fields=id,title,share_url,create_time,view_count,like_count', token, {
    method: 'POST',
    json: { max_count: 10 },
  });
  return (data.videos ?? []).map((video) => ({
    id: video.id ?? '',
    title: video.title ?? '',
    shareUrl: video.share_url ?? null,
    createdAt: video.create_time ?? null,
    viewCount: video.view_count ?? null,
    likeCount: video.like_count ?? null,
  }));
}

/** Revoke the grant, as Disconnect does in the product. Best effort. */
export async function revokeTikTokToken(token: string): Promise<void> {
  const env = serverEnv();
  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) return;
  await fetch(`${API}/v2/oauth/revoke/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: env.TIKTOK_CLIENT_KEY,
      client_secret: env.TIKTOK_CLIENT_SECRET,
      token,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
}
