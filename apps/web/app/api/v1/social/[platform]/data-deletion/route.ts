import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { serverEnv } from '@orbit/config';
import { PLATFORMS, type Platform } from '@orbit/core';
import { logger, logError, withLogContext } from '@orbit/observability';
import { handleDataDeletion } from '@/features/social/platform-callbacks';
import { SignedRequestInvalid } from '@/features/social/signed-request';
import { appSecretFor } from '@/features/social/platform-secrets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const suffix = 'data-deletion';

/**
 * A data deletion request, relayed by the platform (SRS §6, §22).
 *
 * Like the deauthorize callback: no session, and the signature is the whole
 * authorisation. Unlike it, the platform expects a specific answer back — a
 * status URL and a confirmation code — so a person can follow their request up.
 *
 * What is deleted is the **connection**, not the agency's content. A client's
 * scheduled and published posts belong to the agency that wrote them; removing
 * them because somebody revoked a login would destroy work nobody asked us to
 * destroy. The status page says so in those words rather than implying more was
 * erased than was.
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
      const env = serverEnv();
      const secret = appSecretFor(platform as Platform, env);

      if (!secret) {
        logger.warn('data deletion callback for an unconfigured platform', { platform });
        return NextResponse.json({ ok: false }, { status: 200 });
      }

      try {
        const form = await request.formData();
        const signedRequest = String(form.get('signed_request') ?? '');

        const result = await handleDataDeletion({
          platform: platform as Platform,
          signedRequest,
          appSecret: secret,
          appUrl: env.APP_URL,
          correlationId,
        });

        // Exactly the two fields Meta expects, and nothing else.
        return NextResponse.json(result);
      } catch (error) {
        if (error instanceof SignedRequestInvalid) {
          logger.warn('rejected an unsigned data deletion callback', {
            securityEvent: true,
            platform,
            reason: error.detail,
          });
          return NextResponse.json({ ok: false }, { status: 200 });
        }

        logError('data deletion callback failed', error, { platform });
        return NextResponse.json({ ok: false }, { status: 200 });
      }
    },
  );
}
