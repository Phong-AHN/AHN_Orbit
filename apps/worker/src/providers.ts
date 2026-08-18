import { serverEnv } from '@orbit/config';
import { logger } from '@orbit/observability';
import { registerProvider, supportedPlatforms, type PublishMedia } from '@orbit/providers';
import { FacebookProvider } from '@orbit/providers/facebook';
import { InstagramProvider } from '@orbit/providers/instagram';
import { TikTokProvider } from '@orbit/providers/tiktok';
import { ThreadsProvider } from '@orbit/providers/threads';
import { MockProvider } from '@orbit/providers/mock';

/**
 * Provider bootstrap for the worker.
 *
 * Deliberately a copy of the web app's rather than a shared module: the two
 * processes may legitimately register different sets — the worker publishes and
 * needs every adapter, the web app mostly needs capabilities — and coupling
 * them would mean a change for one silently changing the other.
 *
 * **The cost of that choice is that adding an adapter means editing two files,
 * and forgetting the second one is invisible until a real publish.** It cost a
 * live job: Instagram was registered in the web app, the composer validated
 * happily against its capabilities, the post was approved and enqueued — and
 * the worker failed it with "Instagram isn't available yet", which reads like a
 * platform outage rather than a missing line here. `providersMatchWeb` in the
 * test suite now compares the two lists so the next one fails at commit.
 *
 * Facebook and Instagram share a Meta app; Business Login for Instagram needs a
 * second one and is optional. Without any Meta app the development mock stands
 * in so the publishing engine can be exercised before App Review completes, and
 * the registry refuses that substitution in production (SRS §42).
 */

let bootstrapped = false;

/**
 * Read a byte range of a media object, for platforms that want the bytes rather
 * than a URL.
 *
 * A ranged GET against the signed URL the subject already built, rather than a
 * storage call: `@orbit/providers` must not depend on `@orbit/storage`, and the
 * publish subject is the one place that knows how to turn a media asset into
 * something fetchable. S3 honours `Range` on a presigned GET, so this needs
 * nothing the URL does not already carry.
 *
 * **The signed URL lives 15 minutes** (`MEDIA_URL_TTL_SECONDS` in
 * `publishing/subject.ts`). An upload slower than that will fail part-way with
 * an expired-URL error rather than silently truncating — loud, and the right
 * failure — but it does bound how large a video this can carry in one publish.
 */
async function readMediaRange(input: {
  media: PublishMedia;
  firstByte: number;
  lastByte: number;
  signal?: AbortSignal | undefined;
}): Promise<Uint8Array> {
  const response = await fetch(input.media.url, {
    headers: { range: `bytes=${input.firstByte}-${input.lastByte}` },
    ...(input.signal ? { signal: input.signal } : {}),
  });

  // 206 is the expected answer. A 200 means the range was ignored and the whole
  // object is coming back, which would corrupt the chunk boundaries — better to
  // stop than to upload the wrong bytes under the right Content-Range header.
  if (response.status !== 206) {
    throw new Error(
      `Ranged read of media ${input.media.id} returned HTTP ${response.status}; expected 206`,
    );
  }

  return new Uint8Array(await response.arrayBuffer());
}

export function ensureProvidersRegistered(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  const env = serverEnv();
  let registeredAny = false;

  if (env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET) {
    registerProvider(
      new TikTokProvider({
        clientKey: env.TIKTOK_CLIENT_KEY,
        clientSecret: env.TIKTOK_CLIENT_SECRET,
        apiVersion: 'v2',
        // Only the worker wires this: the web app never moves media bytes.
        readMediaRange,
      }),
    );
    registeredAny = true;
  }

  if (env.THREADS_APP_ID && env.THREADS_APP_SECRET) {
    registerProvider(
      new ThreadsProvider({
        appId: env.THREADS_APP_ID,
        appSecret: env.THREADS_APP_SECRET,
        apiVersion: 'v1.0',
      }),
    );
    registeredAny = true;
  }

  if (env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET) {
    registerProvider(
      new FacebookProvider({
        appId: env.FACEBOOK_APP_ID,
        appSecret: env.FACEBOOK_APP_SECRET,
        apiVersion: env.FACEBOOK_GRAPH_VERSION,
        webhookVerifyToken: env.FACEBOOK_WEBHOOK_VERIFY_TOKEN,
      }),
    );

    registerProvider(
      new InstagramProvider({
        appId: env.FACEBOOK_APP_ID,
        appSecret: env.FACEBOOK_APP_SECRET,
        apiVersion: env.FACEBOOK_GRAPH_VERSION,
        ...(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET
          ? { login: { appId: env.INSTAGRAM_APP_ID, appSecret: env.INSTAGRAM_APP_SECRET } }
          : {}),
      }),
    );
    registeredAny = true;
  }

  // The mock stands in only when *nothing* real is configured. Registering it
  // alongside a real adapter would put a fake platform next to a live one in
  // the same list, which is exactly the confusion the registry's
  // production guard exists to prevent.
  if (!registeredAny) {
    // Throws if this is somehow reached in production.
    registerProvider(new MockProvider(), { developmentOnly: true });
    logger.warn('no platform is configured; the worker is using the development mock', {
      hint: 'Set FACEBOOK_APP_ID / FACEBOOK_APP_SECRET or TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET to publish for real.',
    });
  }

  logger.info('providers registered', { platforms: supportedPlatforms() });
}
