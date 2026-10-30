import { NextResponse, type NextRequest } from 'next/server';
import { logger } from '@orbit/observability';
import {
  TIKTOK_REVIEW_MAX_UPLOAD_BYTES,
  TIKTOK_REVIEW_PATH,
  TIKTOK_REVIEW_SESSION_COOKIE,
  openTikTokSession,
  tiktokReviewEnabled,
} from '@/features/tiktok-review/session';
import { getCreatorInfo, postVideo } from '@/features/tiktok-review/tiktok';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

/**
 * `video.publish`, demonstrated: one Direct Post to the reviewer's own account.
 *
 * Everything the form chose is checked again here against the creator's live
 * options — the privacy level must be one TikTok offered, interaction settings
 * the creator turned off stay off, branded content cannot be private, and the
 * consent box must be ticked — so the page cannot post anything the product's
 * own rules would refuse.
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

  const form = await request.formData();
  const file = form.get('video');
  const title = String(form.get('title') ?? '')
    .trim()
    .slice(0, 2_200);
  const privacy = String(form.get('privacy') ?? '');
  const disclose = form.get('disclose') === 'on';
  const brandOrganic = disclose && form.get('brandOrganic') === 'on';
  const brandContent = disclose && form.get('brandContent') === 'on';

  if (!(file instanceof File) || file.size === 0) return fail('file');
  if (file.size > TIKTOK_REVIEW_MAX_UPLOAD_BYTES) return fail('size');
  if (!VIDEO_TYPES.has(file.type)) return fail('type');
  if (form.get('consent') !== 'on') return fail('consent_box');
  if (disclose && !brandOrganic && !brandContent) return fail('disclosure');

  try {
    const creator = await getCreatorInfo(session.accessToken);
    if (!creator.privacyLevelOptions.includes(privacy)) return fail('privacy');
    if (brandContent && privacy === 'SELF_ONLY') return fail('branded_private');

    const publishId = await postVideo(
      session.accessToken,
      {
        title,
        privacyLevel: privacy,
        // A setting the creator disabled stays disabled, whatever was sent.
        disableComment: creator.commentDisabled || form.get('allowComment') !== 'on',
        disableDuet: creator.duetDisabled || form.get('allowDuet') !== 'on',
        disableStitch: creator.stitchDisabled || form.get('allowStitch') !== 'on',
        brandContent,
        brandOrganic,
      },
      file,
    );
    back.searchParams.set('published', publishId);
    return NextResponse.redirect(back, 303);
  } catch (error) {
    logger.warn('tiktok review page: post failed', {
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
