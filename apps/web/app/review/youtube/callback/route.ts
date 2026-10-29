import { NextResponse, type NextRequest } from 'next/server';
import { getProvider } from '@orbit/providers';
import { logger } from '@orbit/observability';
import { ensureProvidersRegistered } from '@/server/providers';
import {
  REVIEW_BASE_PATH,
  REVIEW_SESSION_COOKIE,
  REVIEW_SESSION_TTL_MS,
  REVIEW_STATE_COOKIE,
  cookieOptions,
  reviewEnabled,
  reviewRedirectUri,
  sealSession,
  stateIsValid,
} from '@/features/google-review/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Google sends the reviewer back here. The code is exchanged for a token, which
 * is kept only in an encrypted cookie — never in the database.
 */
export async function GET(request: NextRequest) {
  if (!reviewEnabled()) return new NextResponse(null, { status: 404 });

  const params = request.nextUrl.searchParams;
  const back = new URL(REVIEW_BASE_PATH, request.url);
  const fail = (reason: string) => {
    back.searchParams.set('error', reason);
    const response = NextResponse.redirect(back, 303);
    response.cookies.set(REVIEW_STATE_COOKIE, '', cookieOptions(0));
    return response;
  };

  if (params.get('error')) return fail('consent');

  const state = params.get('state') ?? '';
  const code = params.get('code') ?? '';
  if (!code || !stateIsValid(state, request.cookies.get(REVIEW_STATE_COOKIE)?.value)) {
    logger.warn('google review page: invalid OAuth state', { securityEvent: true });
    return fail('state');
  }

  try {
    ensureProvidersRegistered();
    const { userCredential } = await getProvider('YOUTUBE').exchangeCode({
      code,
      redirectUri: reviewRedirectUri(),
    });
    if (!userCredential) return fail('token');

    const expiresAt = Math.min(
      userCredential.expiresAt?.getTime() ?? Date.now() + REVIEW_SESSION_TTL_MS,
      Date.now() + REVIEW_SESSION_TTL_MS,
    );

    const response = NextResponse.redirect(back, 303);
    response.cookies.set(REVIEW_STATE_COOKIE, '', cookieOptions(0));
    response.cookies.set(
      REVIEW_SESSION_COOKIE,
      sealSession({
        accessToken: userCredential.accessToken,
        expiresAt,
        scopes: [...userCredential.scopes],
      }),
      cookieOptions(expiresAt - Date.now()),
    );
    return response;
  } catch (error) {
    logger.warn('google review page: token exchange failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return fail('token');
  }
}
