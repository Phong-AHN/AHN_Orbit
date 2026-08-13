import { serverEnv } from '@orbit/config';
import { logger } from '@orbit/observability';
import { registerProvider, supportedPlatforms } from '@orbit/providers';
import { FacebookProvider } from '@orbit/providers/facebook';
import { InstagramProvider } from '@orbit/providers/instagram';
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

export function ensureProvidersRegistered(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  const env = serverEnv();

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
  } else {
    // Throws if this is somehow reached in production.
    registerProvider(new MockProvider(), { developmentOnly: true });
    logger.warn('Facebook is not configured; the worker is using the development mock', {
      hint: 'Set FACEBOOK_APP_ID and FACEBOOK_APP_SECRET to publish for real.',
    });
  }

  logger.info('providers registered', { platforms: supportedPlatforms() });
}
