import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  SESSION_COOKIE_NAME,
  clearedSessionCookie,
  createSession,
  readSession,
  resolveUser,
  revokeSessions,
} from '@orbit/auth';
import { logger } from '@orbit/observability';
import { readJsonBody, withPublic } from '@/server/with-auth';
import { jsonOk } from '@/server/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Session exchange (T1.1).
 *
 *   Browser: Firebase client SDK sign-in            → ID token
 *   POST here: server verifies the token            → HttpOnly session cookie
 *
 * The ID token is the *only* thing accepted. No user id, email, or role is
 * read from the body — everything about the identity comes from verifying the
 * token server-side.
 */

const bodySchema = z.object({
  idToken: z.string().min(1, 'idToken is required').max(8192),
});

export const POST = withPublic({ name: 'POST /api/v1/auth/session' }, async (request) => {
  // readJsonBody rather than a bare parse, so the "a client may never supply a
  // server-derived field" rule holds uniformly on every route rather than only
  // on tenant-scoped ones. Here such a field would merely be ignored, but a
  // rule with exceptions is a rule nobody can rely on.
  const body = await readJsonBody(request, bodySchema);

  const { cookie, identity } = await createSession(body.idToken);

  // Provision (or link) the User row now, so the very first authenticated
  // request already has an id to resolve rather than racing to create one.
  const user = await resolveUser(identity);

  const response = jsonOk({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      timezone: user.timezone,
    },
  });

  response.cookies.set(cookie);
  return response;
});

/**
 * Sign out.
 *
 * Revokes refresh tokens as well as clearing the cookie, so a copy of the
 * cookie taken beforehand stops working immediately — verification always runs
 * the revocation check.
 */
export const DELETE = withPublic({ name: 'DELETE /api/v1/auth/session' }, async (request) => {
  const cookieValue = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  if (cookieValue) {
    try {
      const identity = await readSession(cookieValue);
      if (identity) await revokeSessions(identity.uid);
    } catch {
      // An unreadable cookie is still cleared below. Signing out must never
      // fail just because the session was already invalid.
      logger.debug('sign-out with an unverifiable session cookie');
    }
  }

  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(clearedSessionCookie());
  return response;
});

/** Explicitly reject other verbs rather than letting Next return a vague 405. */
export function GET(_request: NextRequest) {
  return NextResponse.json(
    { error: { code: 'NOT_FOUND', message: 'Not found', retryable: false } },
    { status: 404 },
  );
}
