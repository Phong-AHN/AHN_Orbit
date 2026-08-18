import { serverEnv } from '@orbit/config';
import { logger } from '@orbit/observability';
import { isSupported, registerProvider, supportedPlatforms } from '@orbit/providers';
import { FacebookProvider } from '@orbit/providers/facebook';
import { InstagramProvider } from '@orbit/providers/instagram';
import { TikTokProvider } from '@orbit/providers/tiktok';
import { ThreadsProvider } from '@orbit/providers/threads';
import { MockProvider } from '@orbit/providers/mock';

/**
 * Provider bootstrap.
 *
 * The single place adapters are wired up. Import this once from anything that
 * needs a provider; registration is idempotent.
 *
 * Facebook and Instagram register only when a Meta app is configured. They
 * share one — Instagram publishing here is "API setup with Facebook Login", so
 * the same app id and secret drive both adapters, and connecting either uses
 * the same consent dialog with different scopes.
 *
 * Without a Meta app the development mock stands in so the composer and
 * calendar can be exercised before App Review completes — and the registry
 * refuses that substitution in production, so the fallback cannot escape.
 *
 * ## Tests never reach a real platform by accident (T1.19, decision D-047)
 *
 * A developer with `FACEBOOK_APP_ID` in their `.env` — which is the normal
 * state — would otherwise have the real adapter registered inside the test
 * suite, because this function is reached from `validatePost` on any
 * transition. That is how the first run of the E2E flow ended up calling
 * `graph.facebook.com` and failing on a real OAuth error.
 *
 * So in `test` the mock is used regardless of configuration. The one deliberate
 * exception is `ORBIT_E2E_REAL_PROVIDER=true`, which exists for the DoD's other
 * half: running the §32 flow **once, manually, against a real Meta Test Page**
 * after App Review. It has to be asked for explicitly and by name.
 */

let bootstrapped = false;

/** Reset the bootstrap latch. Tests only, so a suite can choose its provider. */
export function resetProviderBootstrap(): void {
  bootstrapped = false;
}

/**
 * Whether a configured platform may register, given the environment.
 *
 * Config alone is not enough in `test`: a developer with real credentials in
 * their `.env` — the normal state — would otherwise get live adapters inside
 * the suite, which is how the first E2E run reached `graph.facebook.com`.
 */
function realProvidersAllowed(env: ReturnType<typeof serverEnv>): boolean {
  if (env.NODE_ENV !== 'test') return true;

  // Opt in, explicitly, for the one manual run against a real Test Page.
  return process.env.ORBIT_E2E_REAL_PROVIDER === 'true';
}

export function ensureProvidersRegistered(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  const env = serverEnv();
  const allowed = realProvidersAllowed(env);
  let registeredAny = false;

  if (allowed && env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET) {
    // No `readMediaRange` here: the web app resolves capabilities, starts OAuth
    // and reads creator info. It never moves media bytes — only the worker
    // publishes — and a provider that cannot upload is the honest shape for it.
    registerProvider(
      new TikTokProvider({
        clientKey: env.TIKTOK_CLIENT_KEY,
        clientSecret: env.TIKTOK_CLIENT_SECRET,
        apiVersion: 'v2',
      }),
    );
    registeredAny = true;
    logger.info('registered TikTok provider', { platforms: ['TIKTOK'] });
  }

  if (allowed && env.THREADS_APP_ID && env.THREADS_APP_SECRET) {
    registerProvider(
      new ThreadsProvider({
        appId: env.THREADS_APP_ID,
        appSecret: env.THREADS_APP_SECRET,
        apiVersion: 'v1.0',
      }),
    );
    registeredAny = true;
    logger.info('registered Threads provider', { platforms: ['THREADS'] });
  }

  if (allowed && env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET) {
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
        // The second Meta app, if there is one. Business Login for Instagram
        // cannot share the Facebook app — Meta allows one API setup per app —
        // so this is either configured separately or the surface is not offered.
        ...(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET
          ? { login: { appId: env.INSTAGRAM_APP_ID, appSecret: env.INSTAGRAM_APP_SECRET } }
          : {}),
      }),
    );

    registeredAny = true;

    logger.info('registered Meta providers', {
      apiVersion: env.FACEBOOK_GRAPH_VERSION,
      platforms: ['FACEBOOK', 'INSTAGRAM'],
      instagramUsernameLogin: Boolean(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET),
    });
  }

  // Only when nothing real registered. A mock sitting beside a live adapter
  // would let a post be validated against a fake platform's rules.
  if (!registeredAny) {
    // Throws if this is somehow reached in production.
    registerProvider(new MockProvider(), { developmentOnly: true });
    logger.warn('using the development mock provider', {
      reason:
        env.NODE_ENV === 'test'
          ? 'tests never call a real platform unless ORBIT_E2E_REAL_PROVIDER=true'
          : 'no platform is configured',
      hint: 'Set FACEBOOK_APP_ID / FACEBOOK_APP_SECRET or TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET to use a real adapter.',
    });
  }

  logger.info('providers registered', { platforms: supportedPlatforms() });
}

export function providerIsSupported(platform: Parameters<typeof isSupported>[0]): boolean {
  ensureProvidersRegistered();
  return isSupported(platform);
}
