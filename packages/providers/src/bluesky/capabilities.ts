import { defineCapabilities, type PlatformCapabilities } from '../capabilities.js';

/**
 * Bluesky capability descriptor (SRS §7).
 *
 * Verified 2026-11-05 against the atproto OAuth and permission specs and the
 * `app.bsky.*` lexicons as published in `@atproto/api`. Bluesky is unlike every
 * other platform here in three ways that shape the adapter:
 *
 *   • **The API is free.** No app review, no paid tier, no per-request price.
 *   • **OAuth is the strictest in the product**: pushed authorization requests,
 *     PKCE, DPoP-bound tokens with server nonces, and `private_key_jwt` client
 *     authentication with a key Social Square publishes.
 *   • **A post's text carries its own markup** as byte ranges ("facets"):
 *     a link or a hashtag is only a link or a hashtag if the post says where
 *     it is, in UTF-8 bytes.
 */

export const BLUESKY_API_VERSION = 'atproto';

/** bsky.social, the authorization server for every account Bluesky hosts. */
export const BLUESKY_AUTHORIZATION_SERVER = 'https://bsky.social';

/** Public AppView: post and profile counts, no authentication, no cost. */
export const BLUESKY_APPVIEW = 'https://public.api.bsky.app';

export const BLUESKY_PLC_DIRECTORY = 'https://plc.directory';

/**
 * Verified: granular permissions, live on bsky.social. Only what publishing
 * needs — create and delete one's own posts, upload images — rather than
 * `transition:generic`, which is everything an app password can do.
 */
export const BLUESKY_SCOPES = [
  'atproto',
  'repo:app.bsky.feed.post?action=create&action=delete',
  'blob:image/*',
] as const;

/** Prefixed for the same reason as X's: the overview totals by name. */
export const BLUESKY_POST_METRICS = [
  'bsky_likes',
  'bsky_reposts',
  'bsky_replies',
  'bsky_quotes',
  'bsky_bookmarks',
] as const;

export const BLUESKY_ACCOUNT_METRICS = ['bsky_followers', 'bsky_following', 'bsky_posts'] as const;

export function blueskyCapabilities(apiVersion: string): PlatformCapabilities {
  return defineCapabilities({
    platform: 'BLUESKY',
    accountType: null,
    apiVersion,
    verifiedOn: '2026-11-05',

    text: {
      supported: true,
      /** Verified: `app.bsky.feed.post#text`, maxGraphemes 300 (maxLength 3000 bytes). */
      maxLength: 300,
      countGraphemes: true,
      // Hashtags and the destination link are written into the text and
      // marked there as facets; there is no other field for either.
      composedText: true,
      allowsEmptyWithMedia: true,
    },

    /** A link is a facet over its own text. No documented ceiling on how many. */
    link: { supported: true, maxCount: 10 },

    media: {
      /** Verified: `app.bsky.embed.images#image`, `image/*`, maxSize 2,000,000 bytes. */
      image: {
        mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
        maxBytes: 2_000_000,
      },
      /**
       * Not built. Video goes through a separate upload service with its own
       * service-auth token and processing job; claiming it here would let the
       * composer accept a file the worker cannot send.
       */
      video: null,
      gif: null,
      /** Verified: `app.bsky.embed.images#images`, maxLength 4. */
      maxAttachments: 4,
      allowsMixedKinds: false,
      carousel: false,
      altText: true,
      required: false,
    },

    /** Verified: a `#tag` facet, up to 64 graphemes. */
    hashtags: { supported: true },
    /**
     * A mention is a facet naming the account's DID, and an `@handle` with no
     * facet is plain text. Resolving handles is not built, so this says no
     * rather than publishing mentions that do not notify anybody.
     */
    mentions: { supported: false },
    firstComment: { supported: false },

    scheduling: { providerSide: false },

    lifecycle: {
      edit: false,
      editOwnPostsOnly: false,
      /** `com.atproto.repo.deleteRecord`. */
      delete: true,
      readStatus: true,
    },

    publishing: {
      idempotencyKey: false,
      /**
       * Strongly: the record key is chosen by Social Square and recorded
       * before the write, so "did it go out?" is one lookup by key.
       */
      reconcilable: true,
      /**
       * A PDS allows 5,000 write points an hour, and a create costs 3. 1,600
       * posts an hour stays under that with room for deletes.
       */
      rateLimit: { maxPosts: 1_600, windowMs: 60 * 60 * 1000 },
    },

    analytics: {
      post: true,
      account: true,
      metrics: [...BLUESKY_POST_METRICS, ...BLUESKY_ACCOUNT_METRICS],
      deprecatedMetrics: [],
    },

    webhooks: { supported: false },
  });
}

/**
 * The client metadata document atproto fetches to learn who Social Square is.
 *
 * Its URL *is* the client id, so the document is built from the same values
 * the adapter uses — one source, or the authorization server sees a client
 * that does not match the requests it receives.
 */
export function blueskyClientMetadata(appUrl: string): Record<string, unknown> {
  const base = appUrl.replace(/\/$/, '');
  return {
    client_id: blueskyClientId(base),
    client_name: 'Social Square',
    client_uri: base,
    logo_uri: `${base}/brand/social-square-icon-512.png`,
    tos_uri: `${base}/terms-of-service`,
    policy_uri: `${base}/privacy-policy`,
    redirect_uris: [`${base}/api/v1/social/oauth/bluesky/callback`],
    scope: BLUESKY_SCOPES.join(' '),
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    application_type: 'web',
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_signing_alg: 'ES256',
    dpop_bound_access_tokens: true,
    jwks_uri: `${base}/oauth/bluesky/jwks.json`,
  };
}

export function blueskyClientId(appUrl: string): string {
  return `${appUrl.replace(/\/$/, '')}/oauth/bluesky/client-metadata.json`;
}
