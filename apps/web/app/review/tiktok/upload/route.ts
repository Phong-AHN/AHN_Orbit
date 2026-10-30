import { NextResponse, type NextRequest } from 'next/server';
import { logger } from '@orbit/observability';
import {
  TIKTOK_REVIEW_MAX_UPLOAD_BYTES,
  TIKTOK_REVIEW_PATH,
  TIKTOK_REVIEW_SESSION_COOKIE,
  openTikTokSession,
  tiktokReviewEnabled,
} from '@/features/tiktok-review/session';
import { uploadToInbox } from '@/features/tiktok-review/tiktok';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

/**
 * `video.upload`, demonstrated: the product's "Send to TikTok for them to
 * finish" mode. The video goes to the reviewer's TikTok inbox; nothing is
 * public until they finish it in TikTok.
 */
export async function POST(request: NextRequest) {
  if (!tiktokReviewEnabled()) return new NextResponse(null, { status: 404 });

  const back = new URL(TIKTOK_REVIEW_PATH, request.url);
  const fail = (reason: string) => {
    back.searchParams.set('error', reason);
    return NextResponse.redirect(back, 303);
  };

  const session = openTikTokSession(request.cookies.get(TIKTOK_REVIEW_SESSION_COOKIE)?.value);
  if (!session) return fail('session');
  if (!session.scopes.includes('video.upload')) return fail('upload_scope');

  const file = (await request.formData()).get('video');
  if (!(file instanceof File) || file.size === 0) return fail('file');
  if (file.size > TIKTOK_REVIEW_MAX_UPLOAD_BYTES) return fail('size');
  if (!VIDEO_TYPES.has(file.type)) return fail('type');

  try {
    back.searchParams.set('inbox', await uploadToInbox(session.accessToken, file));
    return NextResponse.redirect(back, 303);
  } catch (error) {
    logger.warn('tiktok review page: inbox upload failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    back.searchParams.set('error', 'post');
    back.searchParams.set(
      'detail',
      (error instanceof Error ? error.message : 'unknown').slice(0, 200),
    );
    return NextResponse.redirect(back, 303);
  }
}
