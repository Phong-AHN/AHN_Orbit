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
