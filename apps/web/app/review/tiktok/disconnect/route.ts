import { NextResponse, type NextRequest } from 'next/server';
import {
  TIKTOK_REVIEW_PATH,
  TIKTOK_REVIEW_SESSION_COOKIE,
  openTikTokSession,
  tiktokCookieOptions,
  tiktokReviewEnabled,
} from '@/features/tiktok-review/session';
import { revokeTikTokToken } from '@/features/tiktok-review/tiktok';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Revoke the grant with TikTok and forget the session — the same as Disconnect in the product. */
export async function POST(request: NextRequest) {
  if (!tiktokReviewEnabled()) return new NextResponse(null, { status: 404 });

  const session = openTikTokSession(request.cookies.get(TIKTOK_REVIEW_SESSION_COOKIE)?.value);
  if (session) await revokeTikTokToken(session.accessToken);

  const back = new URL(TIKTOK_REVIEW_PATH, request.url);
  back.searchParams.set('disconnected', '1');
  const response = NextResponse.redirect(back, 303);
  response.cookies.set(TIKTOK_REVIEW_SESSION_COOKIE, '', tiktokCookieOptions(0));
  return response;
}
