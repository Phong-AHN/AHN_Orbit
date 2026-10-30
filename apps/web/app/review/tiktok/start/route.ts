import { NextResponse, type NextRequest } from 'next/server';
import { getProvider } from '@orbit/providers';
import { ensureProvidersRegistered } from '@/server/providers';
import {
  TIKTOK_REVIEW_ENTRY,
  TIKTOK_REVIEW_STATE_COOKIE,
  TIKTOK_REVIEW_UNLOCK_COOKIE,
  issueTikTokState,
  tiktokCookieOptions,
  tiktokReviewEnabled,
  tiktokReviewRedirectUri,
  tiktokUnlockIsValid,
} from '@/features/tiktok-review/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Send the reviewer to TikTok's authorization screen with exactly the scopes
 * the product requests — from the same adapter. Only for a browser that
 * entered the access code on the homepage.
 */
export async function POST(request: NextRequest) {
  if (!tiktokReviewEnabled()) return new NextResponse(null, { status: 404 });

  if (!tiktokUnlockIsValid(request.cookies.get(TIKTOK_REVIEW_UNLOCK_COOKIE)?.value)) {
    return NextResponse.redirect(new URL(TIKTOK_REVIEW_ENTRY, request.url), 303);
  }

  ensureProvidersRegistered();
  const { state, nonce } = issueTikTokState();
  const { url } = getProvider('TIKTOK').getAuthorizationUrl({
    redirectUri: tiktokReviewRedirectUri(),
    state,
  });

  const response = NextResponse.redirect(url, 303);
  response.cookies.set(TIKTOK_REVIEW_STATE_COOKIE, nonce, tiktokCookieOptions(10 * 60 * 1000));
  return response;
}
