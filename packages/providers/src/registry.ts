import { serverEnv } from '@orbit/config';
import { NotFoundError, ValidationError, type Platform } from '@orbit/core';
import type { SocialProvider } from './types.js';
import type { PlatformCapabilities } from './capabilities.js';

/**
 * The provider registry.
 *
 * The single place platforms are enumerated. Everything else in the system asks
 * the registry rather than switching on a platform name, which is what keeps
 * `if (platform === …)` out of the core (SRS §8).
 *
 * A platform with no registered adapter is *not supported* — the registry says
 * so plainly rather than letting a half-built integration reach a user.
 */

const providers = new Map<Platform, SocialProvider>();

/** Adapters that must never serve real traffic (SRS §42). */
const developmentOnly = new Set<Platform>();

export interface RegisterOptions {
  /**
   * Marks an adapter as development-only. Registering one while
   * APP_ENV=production throws, so a mock cannot reach production by
   * misconfiguration — the failure is at boot, not at publish time.
   */
  developmentOnly?: boolean;
}

export function registerProvider(provider: SocialProvider, options: RegisterOptions = {}): void {
  if (options.developmentOnly) {
    const env = serverEnv();
    if (env.APP_ENV === 'production' || env.NODE_ENV === 'production') {
      throw new Error(
        `Refusing to register the development-only ${provider.platform} adapter in production.`,
      );
    }
    developmentOnly.add(provider.platform);
  }

  // Validating the descriptor here means a malformed one fails at boot rather
  // than at the first publish attempt.
  provider.capabilities(null);

  providers.set(provider.platform, provider);
}

export function getProvider(platform: Platform): SocialProvider {
  const provider = providers.get(platform);
  if (!provider) {
    throw new NotFoundError('Provider', {
      userMessage: `${humanise(platform)} isn't available yet.`,
      context: { platform, registered: [...providers.keys()] },
    });
  }
  return provider;
}

export function tryGetProvider(platform: Platform): SocialProvider | undefined {
  return providers.get(platform);
}

export function isSupported(platform: Platform): boolean {
  return providers.has(platform);
}

export function supportedPlatforms(): Platform[] {
  return [...providers.keys()].sort();
}

export function isDevelopmentOnly(platform: Platform): boolean {
  return developmentOnly.has(platform);
}

/**
 * Capabilities for a connected account.
 *
 * The one call the composer, validator and worker all make. Returning the
 * descriptor rather than the provider keeps callers from reaching for
 * platform-specific methods they have no business using.
 */
export function capabilitiesFor(
  platform: Platform,
  accountType?: string | null,
): PlatformCapabilities {
  return getProvider(platform).capabilities(accountType ?? null);
}

/**
 * Assert a capability before calling the method it gates.
 *
 * Turns "the adapter threw something odd" into a clear 422 that names the
 * missing capability, and keeps adapters from having to implement stubs that
 * only ever throw.
 */
export function assertCapability(
  capabilities: PlatformCapabilities,
  predicate: (c: PlatformCapabilities) => boolean,
  capabilityName: string,
  userMessage: string,
): void {
  if (predicate(capabilities)) return;

  throw new ValidationError(`${capabilities.platform} does not support ${capabilityName}`, {
    userMessage,
    context: { platform: capabilities.platform, capability: capabilityName },
  });
}

/** Test seam. Never called by application code. */
export function resetRegistry(): void {
  providers.clear();
  developmentOnly.clear();
}

function humanise(platform: Platform): string {
  return platform
    .split('_')
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Frame-rate windows the registered platforms publish video in.
 *
 * Asked at upload time so a file nothing can publish is refused while somebody
 * is still looking at the picker, rather than hours later when a scheduled post
 * fails. The media layer must not know TikTok's numbers — that is the rule this
 * whole layer exists to keep — so it asks the descriptors instead.
 *
 * Empty means no registered platform publishes video at all. Storing a file for
 * a platform added later is a reasonable thing to want, so callers treat that
 * as "nothing to check" rather than as "refuse everything".
 */
export function videoFrameRateWindows(): Array<{
  platform: Platform;
  min: number | undefined;
  max: number | undefined;
}> {
  const windows: Array<{ platform: Platform; min: number | undefined; max: number | undefined }> =
    [];

  for (const platform of supportedPlatforms()) {
    const video = capabilitiesFor(platform).media.video;
    if (!video) continue;
    windows.push({ platform, min: video.minFrameRate, max: video.maxFrameRate });
  }

  return windows;
}

/**
 * Whether **some** platform would take a video at this rate.
 *
 * A union rather than an intersection, deliberately: an asset is not tied to a
 * platform when it is uploaded, and refusing a file that one platform publishes
 * happily because another would not is the wrong trade. An absent bound on a
 * window means that side is unbounded there.
 */
export function frameRateAcceptedAnywhere(rate: number): boolean {
  const windows = videoFrameRateWindows();
  if (windows.length === 0) return true;

  return windows.some(
    (window) =>
      (window.min === undefined || rate >= window.min) &&
      (window.max === undefined || rate <= window.max),
  );
}
