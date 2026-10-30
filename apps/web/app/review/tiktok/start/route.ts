import { NextResponse, type NextRequest } from 'next/server';
import { getProvider } from '@orbit/providers';
import { logger } from '@orbit/observability';
import { ensureProvidersRegistered } from '@/server/providers';
import {
  TIKTOK_REVIEW_PATH,
  TIKTOK_REVIEW_STATE_COOKIE,
  issueTikTokState,
  tiktokAccessCodeMatches,
  tiktokCookieOptions,
  tiktokReviewEnabled,
  tiktokReviewRedirectUri,
} from '@/features/tiktok-review/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Check the reviewer's access code, then send them to TikTok's authorization
 * screen with exactly the scopes the product requests — from the same adapter.
 */
export async function POST(request: NextRequest) {
  if (!tiktokReviewEnabled()) return new NextResponse(null, { status: 404 });

  const form = await request.formData();
  const back = new URL(TIKTOK_REVIEW_PATH, request.url);

  if (!tiktokAccessCodeMatches(String(form.get('code') ?? ''))) {
    logger.warn('tiktok review page: wrong access code', { securityEvent: true });
    back.searchParams.set('error', 'code');
    return NextResponse.redirect(back, 303);
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
