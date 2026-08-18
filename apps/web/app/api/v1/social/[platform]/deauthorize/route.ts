import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { serverEnv } from '@orbit/config';
import { PLATFORMS, type Platform } from '@orbit/core';
import { logger, logError, withLogContext } from '@orbit/observability';
import { handleDeauthorize } from '@/features/social/platform-callbacks';
import { SignedRequestInvalid } from '@/features/social/signed-request';
import { appSecretFor } from '@/features/social/platform-secrets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const suffix = 'deauthorize';

/**
 * The platform telling us somebody removed the app (SRS §6).
 *
 * **No session, no tenant, no `withAuth`.** This arrives from the internet with
 * nobody logged in, so the `signed_request` signature is the entire
 * authorisation: an unsigned or badly signed POST must not be able to
 * disconnect an account.
 *
 * Always answers 200. Meta retries a failing callback, and there is nothing a
 * retry can fix here — a bad signature stays bad, and a hammered endpoint is
 * worse than a logged refusal. The one thing that would genuinely cost somebody
 * a post is leaving the account ACTIVE, and that is what this prevents.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ platform: string }> },
): Promise<Response> {
  const { platform: raw } = await params;
  const platform = raw.toUpperCase();

  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  const correlationId = randomUUID();

  return withLogContext(
    { correlationId, route: `POST /api/v1/social/{platform}/${suffix}` },
    async () => {
      const secret = appSecretFor(platform as Platform, serverEnv());
      if (!secret) {
        logger.warn('deauthorize callback for an unconfigured platform', { platform });
        return NextResponse.json({ ok: false }, { status: 200 });
      }

      try {
        const form = await request.formData();
        const signedRequest = String(form.get('signed_request') ?? '');

        const result = await handleDeauthorize({
          platform: platform as Platform,
          signedRequest,
          appSecret: secret,
          correlationId,
        });

        return NextResponse.json({ ok: true, accounts: result.handled });
      } catch (error) {
        if (error instanceof SignedRequestInvalid) {
          // A security event: something posted here that could not sign. Logged
          // with the reason and nothing from the body, which is unverified input.
          logger.warn('rejected an unsigned deauthorize callback', {
            securityEvent: true,
            platform,
            reason: error.detail,
          });
          return NextResponse.json({ ok: false }, { status: 200 });
        }

        logError('deauthorize callback failed', error, { platform });
        return NextResponse.json({ ok: false }, { status: 200 });
      }
    },
  );
}
