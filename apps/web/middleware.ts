import { NextResponse, type NextRequest } from 'next/server';
import { canonicalRedirect } from './src/server/canonical-host';

/**
 * Pages move to `APP_URL`'s host in production, so the session and OAuth
 * cookies are always set where the platforms send people back to. See
 * `canonical-host.ts`.
 */
export function middleware(request: NextRequest) {
  const target = canonicalRedirect({
    url: request.nextUrl,
    method: request.method,
    appUrl: process.env.APP_URL,
    vercelEnv: process.env.VERCEL_ENV,
  });

  return target ? NextResponse.redirect(target, 308) : NextResponse.next();
}

export const config = {
  // Static files never need moving, and skipping them keeps this off the hot path.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|brand/).*)'],
};
