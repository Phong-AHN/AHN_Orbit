import { NextResponse, type NextRequest } from 'next/server';
import { logger } from '@orbit/observability';
import { withinLimit } from '@/features/agent/http';
import {
  TIKTOK_REVIEW_PATH,
  TIKTOK_REVIEW_SESSION_TTL_MS,
  TIKTOK_REVIEW_UNLOCK_COOKIE,
  issueTikTokUnlock,
  tiktokAccessCodeMatches,
  tiktokCookieOptions,
  tiktokReviewEnabled,
} from '@/features/tiktok-review/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The code from the homepage's "TikTok app review" section.
 *
 * Right: a signed, thirty-minute unlock cookie and on to the test page. Wrong:
 * back to the section with a message. Ten tries per ten minutes per address,
 * so the code cannot be guessed by trying.
 */
export async function POST(request: NextRequest) {
  if (!tiktokReviewEnabled()) return new NextResponse(null, { status: 404 });

  const home = new URL('/', request.url);
  home.hash = 'tiktok-review';

  if (!(await withinLimit('tiktok-review', request, { capacity: 10, refillWindowMs: 600_000 }))) {
    home.searchParams.set('tiktok_review', 'slow');
    return NextResponse.redirect(home, 303);
  }

  const form = await request.formData();
  if (!tiktokAccessCodeMatches(String(form.get('code') ?? ''))) {
    logger.warn('tiktok review: wrong access code on the homepage', { securityEvent: true });
    home.searchParams.set('tiktok_review', 'code');
    return NextResponse.redirect(home, 303);
  }

  const response = NextResponse.redirect(new URL(TIKTOK_REVIEW_PATH, request.url), 303);
  response.cookies.set(
    TIKTOK_REVIEW_UNLOCK_COOKIE,
    issueTikTokUnlock(),
    tiktokCookieOptions(TIKTOK_REVIEW_SESSION_TTL_MS),
  );
  return response;
}
