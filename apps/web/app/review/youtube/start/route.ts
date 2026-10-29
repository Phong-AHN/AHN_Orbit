import { NextResponse, type NextRequest } from 'next/server';
import { getProvider } from '@orbit/providers';
import { logger } from '@orbit/observability';
import { ensureProvidersRegistered } from '@/server/providers';
import {
  REVIEW_BASE_PATH,
  REVIEW_STATE_COOKIE,
  accessCodeMatches,
  cookieOptions,
  issueState,
  reviewEnabled,
  reviewRedirectUri,
} from '@/features/google-review/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Check the reviewer's access code, then send them to Google's consent screen
 * with exactly the scopes the product requests — from the same adapter.
 */
export async function POST(request: NextRequest) {
  if (!reviewEnabled()) return new NextResponse(null, { status: 404 });

  const form = await request.formData();
  const code = String(form.get('code') ?? '');
  const back = new URL(REVIEW_BASE_PATH, request.url);

  if (!accessCodeMatches(code)) {
    logger.warn('google review page: wrong access code', { securityEvent: true });
    back.searchParams.set('error', 'code');
    return NextResponse.redirect(back, 303);
  }

  ensureProvidersRegistered();
  const { state, nonce } = issueState();
  const { url } = getProvider('YOUTUBE').getAuthorizationUrl({
    redirectUri: reviewRedirectUri(),
    state,
  });

  const response = NextResponse.redirect(url, 303);
  response.cookies.set(REVIEW_STATE_COOKIE, nonce, cookieOptions(10 * 60 * 1000));
  return response;
}
