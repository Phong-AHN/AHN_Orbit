import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { PLATFORMS, type Platform } from '@orbit/core';
import { Prisma, platformDb } from '@orbit/db';
import { logError, logger, withLogContext } from '@orbit/observability';
import { tryGetProvider } from '@orbit/providers';
import { enqueue } from '@orbit/queue';
import { ensureProvidersRegistered } from '@/server/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Platform webhooks: comments and private messages as they happen (**D-107**).
 *
 * No session, like the deauthorize and data-deletion callbacks — the signature
 * over the raw body is the whole authorisation, and it is checked by the
 * adapter, which is the only code that knows how this platform signs.
 *
 * ## Fast, because Meta is waiting
 *
 * Meta retries a delivery that is not acknowledged and disables the
 * subscription after an hour of failures. So this does the least that makes
 * the delivery safe — verify, store each event, enqueue it — and answers. The
 * work of matching accounts, writing rows and notifying people happens in the
 * worker. Stored *before* it is queued, so a queue that is down costs minutes,
 * not messages: the worker's sweep picks up anything left waiting.
 *
 * ## Idempotent
 *
 * Each event is stored under the platform's own id, unique per platform. A
 * retried delivery finds its events already there and enqueues nothing new.
 *
 * Nothing from the body is logged. It is somebody's private message.
 */

/** Far above any real delivery; a body this large is not Meta's. */
const MAX_BODY_BYTES = 1_000_000;

type Params = { params: Promise<{ platform: string }> };

function providerFor(raw: string) {
  const platform = raw.toUpperCase();
  if (!(PLATFORMS as readonly string[]).includes(platform)) return null;

  ensureProvidersRegistered();
  const provider = tryGetProvider(platform as Platform);
  if (!provider?.capabilities().webhooks.supported) return null;

  return { platform: platform as Platform, provider };
}

/** The subscription handshake. */
export async function GET(request: Request, { params }: Params): Promise<Response> {
  const resolved = providerFor((await params).platform);
  if (!resolved?.provider.webhookChallenge) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  const query = Object.fromEntries(new URL(request.url).searchParams.entries());
  const challenge = resolved.provider.webhookChallenge(query);

  if (challenge === null) {
    logger.warn('refused a webhook subscription handshake', {
      securityEvent: true,
      platform: resolved.platform,
    });
    return NextResponse.json({ ok: false }, { status: 403 });
  }

  // The challenge goes back exactly as sent, as plain text.
  return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const resolved = providerFor((await params).platform);
  if (!resolved?.provider.verifyWebhook || !resolved.provider.parseWebhook) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }
  const { platform, provider } = resolved;
  const correlationId = randomUUID();

  return withLogContext({ correlationId, route: 'POST /api/v1/webhooks/{platform}' }, async () => {
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false }, { status: 413 });
    }

    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    if (!provider.verifyWebhook?.({ headers, rawBody })) {
      logger.warn('rejected an unsigned webhook delivery', { securityEvent: true, platform });
      return NextResponse.json({ ok: false }, { status: 401 });
    }

    const events = provider.parseWebhook?.({ headers, rawBody }) ?? [];
    let stored = 0;

    for (const event of events) {
      let id: string;
      try {
        const row = await platformDb.webhookEvent.create({
          data: {
            provider: platform,
            externalEventId: event.externalEventId,
            signatureValid: true,
            // The worker reduces this to its kind once processed.
            payload: JSON.parse(JSON.stringify(event)) as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        id = row.id;
      } catch (error) {
        // A retry of a delivery already stored. Nothing to do.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          continue;
        }
        // Anything else is ours: answer with an error so Meta retries the
        // whole delivery, which the unique key makes safe.
        logError('failed to store a webhook event', error, { platform });
        return NextResponse.json({ ok: false }, { status: 500 });
      }

      stored += 1;

      try {
        await enqueue(
          'webhooks',
          { correlationId, webhookEventId: id },
          { jobId: `webhook-${id}` },
        );
      } catch (error) {
        // Stored, so not lost: the worker's sweep requeues it within minutes.
        logError('failed to enqueue a stored webhook event', error, { platform });
      }
    }

    logger.info('webhook delivery accepted', { platform, events: events.length, stored });
    return NextResponse.json({ ok: true });
  });
}
