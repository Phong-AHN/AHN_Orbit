import { defineCapabilities, type PlatformCapabilities } from '../capabilities.js';

/**
 * X capability descriptor (SRS §7).
 *
 * Verified against docs.x.com on 2026-11-04. Three things about X shape
 * everything below:
 *
 *   • **Every request is billed.** The X API is pay-per-usage: a post costs
 *     $0.015, a post *with a URL* $0.20, and every read is charged per
 *     resource. Nothing here polls more than it must, and analytics read one
 *     post at a time on the sweep's schedule rather than on page views.
 *   • **The limit is 280 weighted characters**, and the weighting matters in
 *     Vietnamese: "ạ", "ệ" and the rest of Latin Extended Additional count as
 *     two. Hashtags and the destination link are written into the post, so
 *     they count too (`composedText`).
 *   • **Access tokens last two hours.** Refresh tokens are issued with
 *     `offline.access` and are replaced on every use, so a renewal must be
 *     stored before the next one starts — see `credential-refresh.ts`.
 */

export const X_API_HOST = 'https://api.x.com';
export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const X_API_VERSION = '2';

/**
 * Verified: OAuth 2.0 scopes, space-delimited.
 *
 * `media.write` is what the v2 media upload endpoints require, and
 * `offline.access` is the only way to receive a refresh token — without it the
 * connection dies two hours after it was made. `users.read` identifies the
 * account and reads its follower count. Deliberately nothing to do with
 * direct messages, likes, follows or lists.
 */
export const X_PUBLISH_SCOPES = [
  'tweet.read',
  'tweet.write',
  'users.read',
  'media.write',
  'offline.access',
] as const;

/**
 * Metric names, prefixed.
 *
 * X's own names (`like_count`, `view_count`) are the same strings TikTok uses,
 * and the analytics overview totals by name — unprefixed, an X like and a
 * TikTok like would be summed as one number, which is the comparison of two
 * different things the overview is careful never to make.
 */
export const X_POST_METRICS = [
  'x_impressions',
  'x_likes',
  'x_replies',
  'x_reposts',
  'x_quotes',
  'x_bookmarks',
  'x_link_clicks',
  'x_profile_clicks',
  'x_engagements',
  'x_video_views',
] as const;

export const X_ACCOUNT_METRICS = ['x_followers', 'x_following', 'x_posts', 'x_listed'] as const;

/**
 * Verified: non-public metrics (link clicks, profile clicks, engagements) are
 * served only for posts created in the last 30 days, and only to the owner.
 * Past that they are reported unsupported, never zero.
 */
export const X_PRIVATE_METRICS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function xCapabilities(apiVersion: string): PlatformCapabilities {
  return defineCapabilities({
    platform: 'X',
    accountType: null,
    apiVersion,
    verifiedOn: '2026-11-04',

    text: {
      supported: true,
      /**
       * 280 weighted characters. Premium accounts may post more, and the API
       * accepts it from them, but nothing tells Orbit which accounts are
       * Premium — so the limit every account has is the one enforced.
       */
      maxLength: 280,
      /** Verified: every URL is wrapped in t.co and counts as 23. */
      linkCharacterCost: 23,
      weightedCounting: true,
      composedText: true,
      allowsEmptyWithMedia: true,
    },

    /**
     * Links work, and they are **expensive**: $0.20 a post instead of $0.015.
     * No documented ceiling on how many; the length limit binds first, at 23
     * each.
     */
    link: { supported: true, maxCount: 10 },

    media: {
      /** Verified: JPG, PNG, GIF and WEBP stills, 5 MB. */
      image: {
        mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
        maxBytes: 5 * 1024 * 1024,
      },
      /**
       * Verified: 0.5 seconds to 20 minutes, aspect ratio 1:3 to 3:1, 60 fps,
       * at least 32×32. The documented maximum of 1280×1024 is not enforced
       * here: X accepts and transcodes the 1080×1920 vertical video every phone
       * records, and refusing it locally would reject posts X takes.
       *
       * The byte ceiling is X's 8 GB cut to 1 GB. The worker streams the file
       * from a signed URL that lives 15 minutes, which is what really bounds it.
       */
      video: {
        mimeTypes: ['video/mp4', 'video/quicktime'],
        maxBytes: 1024 * 1024 * 1024,
        minWidth: 32,
        minHeight: 32,
        minAspectRatio: 1 / 3,
        maxAspectRatio: 3,
        minDurationMs: 500,
        maxDurationMs: 20 * 60 * 1000,
        maxFrameRate: 60,
      },
      /** Verified: 15 MB, up to 1280×1080. */
      gif: {
        mimeTypes: ['image/gif'],
        maxBytes: 15 * 1024 * 1024,
        maxWidth: 1280,
        maxHeight: 1080,
      },
      /** Verified: up to 4 photos, or 1 animated GIF, or 1 video. */
      maxAttachments: 4,
      soloKinds: ['VIDEO', 'GIF'],
      allowsMixedKinds: false,
      carousel: false,
      /** Verified: `POST /2/media/metadata`, up to 1,000 characters, stills and GIFs. */
      altText: true,
      required: false,
    },

    hashtags: { supported: true },
    /** A plain `@handle` in the text is a mention on X; nothing to look up. */
    mentions: { supported: true },
    /** A reply to one's own post is a thread; not built. */
    firstComment: { supported: false },

    scheduling: { providerSide: false },

    lifecycle: {
      /** Editing a post through the API is not offered by X v2. */
      edit: false,
      editOwnPostsOnly: false,
      /** Verified: `DELETE /2/tweets/:id`. */
      delete: true,
      readStatus: true,
    },

    publishing: {
      idempotencyKey: false,
      /** The account's recent posts can be listed and matched by text. */
      reconcilable: true,
      /**
       * UNVERIFIED for the pay-per-usage plan, which publishes per-endpoint
       * request limits rather than a posting cap. 300 posts in three hours per
       * account is X's long-standing posting limit and a safe budget.
       */
      rateLimit: { maxPosts: 300, windowMs: 3 * 60 * 60 * 1000 },
    },

    analytics: {
      post: true,
      account: true,
      metrics: [...X_POST_METRICS, ...X_ACCOUNT_METRICS],
      deprecatedMetrics: [],
    },

    webhooks: { supported: false },
  });
}
