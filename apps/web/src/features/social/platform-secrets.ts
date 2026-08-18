import type { serverEnv } from '@orbit/config';
import type { Platform } from '@orbit/core';

/**
 * The app secret a platform's signed callbacks are signed with.
 *
 * Kept in one place because getting it wrong is silent: a Threads callback
 * verified against the Facebook secret simply fails every signature, and the
 * log says "signature does not match" for a request that was perfectly genuine.
 *
 * Returns `undefined` for a platform this deployment has not configured, which
 * the routes treat as "acknowledge and do nothing" rather than as an error —
 * a callback for a platform we do not run is not a failure.
 */
export function appSecretFor(
  platform: Platform,
  env: ReturnType<typeof serverEnv>,
): string | undefined {
  switch (platform) {
    case 'THREADS':
      // Its own pair. A Threads app issues two, and this is not the other one.
      return env.THREADS_APP_SECRET;
    case 'INSTAGRAM':
      // Business Login for Instagram has its own app; the Page-linked surface
      // rides on the Facebook one.
      return env.INSTAGRAM_APP_SECRET ?? env.FACEBOOK_APP_SECRET;
    case 'FACEBOOK':
      return env.FACEBOOK_APP_SECRET;
    default:
      // TikTok signs nothing back to us: it has no deauthorize or deletion
      // callback, so there is no secret to hand out here.
      return undefined;
  }
}
