import { NextResponse, type NextRequest } from 'next/server';
import {
  REVIEW_BASE_PATH,
  REVIEW_SESSION_COOKIE,
  cookieOptions,
  reviewEnabled,
} from '@/features/google-review/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Forget the session — the same as Disconnect in the product, which is to say
 * **without** revoking anything at Google.
 *
 * This used to call `oauth2.googleapis.com/revoke`. Google revokes the whole
 * grant between that Google account and this OAuth client, and this page shares
 * its client with the product. So testing here with a Google account whose
 * channel is also connected in Social Square, then pressing Disconnect, killed
 * that channel's refresh token: the next renewal failed with `invalid_grant`
 * and the channel showed as disconnected. The product's adapter has never
 * revoked, for the same reason (`YouTubeProvider.revoke`). Somebody who wants
 * the grant gone removes it from their Google account, which the page links to.
 */
export async function POST(request: NextRequest) {
  if (!reviewEnabled()) return new NextResponse(null, { status: 404 });

  const back = new URL(REVIEW_BASE_PATH, request.url);
  back.searchParams.set('disconnected', '1');
  const response = NextResponse.redirect(back, 303);
  response.cookies.set(REVIEW_SESSION_COOKIE, '', cookieOptions(0));
  return response;
}
