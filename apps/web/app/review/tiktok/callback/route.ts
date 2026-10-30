import { NextResponse, type NextRequest } from 'next/server';
import { getProvider } from '@orbit/providers';
import { logger } from '@orbit/observability';
import { ensureProvidersRegistered } from '@/server/providers';
import {
  TIKTOK_REVIEW_PATH,
  TIKTOK_REVIEW_SESSION_COOKIE,
  TIKTOK_REVIEW_SESSION_TTL_MS,
  TIKTOK_REVIEW_STATE_COOKIE,
  sealTikTokSession,
  tiktokCookieOptions,
  tiktokReviewEnabled,
  tiktokReviewRedirectUri,
  tiktokStateIsValid,
} from '@/features/tiktok-review/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * TikTok sends the reviewer back here. The code is exchanged through the
 * product's own adapter, and the token is kept only in an encrypted cookie —
 * never in the database.
 */
export async function GET(request: NextRequest) {
  if (!tiktokReviewEnabled()) return new NextResponse(null, { status: 404 });

  const params = request.nextUrl.searchParams;
  const back = new URL(TIKTOK_REVIEW_PATH, request.url);
  const fail = (reason: string) => {
    back.searchParams.set('error', reason);
    const response = NextResponse.redirect(back, 303);
    response.cookies.set(TIKTOK_REVIEW_STATE_COOKIE, '', tiktokCookieOptions(0));
    return response;
  };

  if (params.get('error')) return fail('consent');

  const code = params.get('code') ?? '';
  if (
    !code ||
    !tiktokStateIsValid(
      params.get('state') ?? '',
      request.cookies.get(TIKTOK_REVIEW_STATE_COOKIE)?.value,
    )
  ) {
    logger.warn('tiktok review page: invalid OAuth state', { securityEvent: true });
    return fail('state');
  }

  try {
    ensureProvidersRegistered();
    const { accounts } = await getProvider('TIKTOK').exchangeCode({
      code,
      redirectUri: tiktokReviewRedirectUri(),
    });
    const account = accounts[0];
    if (!account?.credential) return fail('token');

    const expiresAt = Math.min(
      account.credential.expiresAt?.getTime() ?? Date.now() + TIKTOK_REVIEW_SESSION_TTL_MS,
      Date.now() + TIKTOK_REVIEW_SESSION_TTL_MS,
    );

    const response = NextResponse.redirect(back, 303);
    response.cookies.set(TIKTOK_REVIEW_STATE_COOKIE, '', tiktokCookieOptions(0));
    response.cookies.set(
      TIKTOK_REVIEW_SESSION_COOKIE,
      sealTikTokSession({
        accessToken: account.credential.accessToken,
        openId: account.externalId,
        expiresAt,
        scopes: [...account.credential.scopes],
      }),
      tiktokCookieOptions(expiresAt - Date.now()),
    );
    return response;
  } catch (error) {
    logger.warn('tiktok review page: token exchange failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return fail('token');
  }
}
