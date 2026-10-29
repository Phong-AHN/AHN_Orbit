import { NextResponse, type NextRequest } from 'next/server';
import {
  REVIEW_BASE_PATH,
  REVIEW_SESSION_COOKIE,
  cookieOptions,
  openSession,
  reviewEnabled,
} from '@/features/google-review/session';
import { revokeToken } from '@/features/google-review/youtube';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Revoke the grant with Google and forget the session — the same as Disconnect in Orbit. */
export async function POST(request: NextRequest) {
  if (!reviewEnabled()) return new NextResponse(null, { status: 404 });

  const session = openSession(request.cookies.get(REVIEW_SESSION_COOKIE)?.value);
  if (session) await revokeToken(session.accessToken);

  const back = new URL(REVIEW_BASE_PATH, request.url);
  back.searchParams.set('disconnected', '1');
  const response = NextResponse.redirect(back, 303);
  response.cookies.set(REVIEW_SESSION_COOKIE, '', cookieOptions(0));
  return response;
}
