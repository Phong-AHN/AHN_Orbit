import { defineCapabilities, type PlatformCapabilities } from '../capabilities.js';

/**
 * Pinterest capability descriptor (SRS §7).
 *
 * Pinterest is not a feed, it is a **filing cabinet**, and two consequences run
 * through everything below:
 *
 *   • **A pin belongs to a board.** There is no "post to Pinterest" — only
 *     "pin to *this* board". The board is a required per-post setting, and the
 *     adapter refuses rather than picking one, because which board a client's
 *     content is filed under is an editorial decision.
 *   • **A video pin needs a cover image.** Pinterest renders a still
 *     everywhere a video is not playing, and `POST /v5/pins` answers 400
 *     without one. Orbit does not generate it — the post carries a second,
 *     image attachment, and a video with no cover is refused with a message
 *     that says to add one.
 *
 * So `maxAttachments` is 2 and `allowsMixedKinds` is true, but that is *not* a
 * carousel: the two slots are "the pin" and "the still for it". Carousels are a
 * separate Pinterest feature, and `carousel: false` says Orbit does not build
 * them.
 */

export const PINTEREST_API_HOST = 'https://api.pinterest.com';
export const PINTEREST_AUTHORIZE_URL = 'https://www.pinterest.com/oauth/';

/**
 * Verified: v5 scopes.
 *
 * `boards:read` is what makes the board picker possible, and without it the
 * required board id would have to be typed by hand. `user_accounts:read`
 * identifies the account being connected. Deliberately *not* `boards:write`
 * (Orbit never creates boards) nor any `*_secret` scope — a secret board is
 * private by intent and an agency tool should not reach into one.
 */
export const PINTEREST_PUBLISH_SCOPES = [
  'user_accounts:read',
  'boards:read',
  'pins:read',
  'pins:write',
] as const;

/**
 * Verified: metric types `GET /v5/pins/{pin_id}/analytics` accepts.
 *
 * The video ones are only returned for video pins, and Pinterest omits rather
 * than zeroes them on an image pin — which is why the adapter maps an absent
 * metric to UNSUPPORTED instead of 0 (SRS §18).
 */
export const PINTEREST_PIN_METRICS = [
  'IMPRESSION',
  'SAVE',
  'PIN_CLICK',
  'OUTBOUND_CLICK',
  'VIDEO_MRC_VIEW',
  'VIDEO_AVG_WATCH_TIME',
  'QUARTILE_95_PERCENT_VIEW',
] as const;

export function pinterestCapabilities(apiVersion: string): PlatformCapabilities {
  return defineCapabilities({
    platform: 'PINTEREST',
    accountType: null,
    apiVersion,
    verifiedOn: '2026-08-19',

    text: {
      supported: true,
      /**
       * Verified: the pin **description** allows 800 characters. The title
       * allows 100 and is taken from the first line, the same shape as
       * YouTube — a caption written for a feed has no title.
       */
      maxLength: 800,
      allowsEmptyWithMedia: true,
    },

    /**
     * The destination link is what a pin is *for*: clicking a pin opens it.
     * Exactly one, on the pin itself, not embedded in the description.
     */
    link: { supported: true, maxCount: 1 },

    media: {
      /** Verified: 20 MB per image, JPEG/PNG/GIF/WebP. */
      image: {
        mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
        maxBytes: 20 * 1024 * 1024,
      },

      /**
       * Verified: up to 2 GB, 4 seconds to 15 minutes, .mp4/.mov/.m4v.
       *
       * UNVERIFIED: Pinterest publishes no frame-rate ceiling, so none is
       * enforced — inventing one would refuse videos the platform accepts.
       */
      video: {
        mimeTypes: ['video/mp4', 'video/quicktime'],
        maxBytes: 2 * 1024 * 1024 * 1024,
        minDurationMs: 4_000,
        maxDurationMs: 15 * 60 * 1000,
      },

      /** A GIF is pinned as an image; Pinterest has no separate GIF type. */
      gif: null,

      /**
       * Two, and only because a video pin needs its cover. Not a gallery —
       * see the note at the top of this file.
       */
      maxAttachments: 2,
      allowsMixedKinds: true,
      carousel: false,
      /** Verified: `alt_text` on the pin, 500 characters. */
      altText: true,
      /** There is no text-only pin. A pin *is* the media. */
      required: true,
    },

    /**
     * Hashtags are plain text in a description on Pinterest — they are not
     * links and Pinterest's own guidance has discouraged them since search
     * moved off them. Supported because people write them; uncapped because
     * the platform imposes nothing beyond the description length.
     */
    hashtags: { supported: true },

    /** Pinterest has no @-mention in a pin description. */
    mentions: { supported: false },

    /** Comments exist, but posting one needs a different API. Not built. */
    firstComment: { supported: false },

    scheduling: {
      /**
       * Pinterest can hold a pin until a future date, but Orbit's queue is the
       * scheduler (SRS §13) and running both would create two answers to "when
       * does this go out".
       */
      providerSide: false,
    },

    lifecycle: {
      /**
       * `PATCH /v5/pins/{id}` exists, but Orbit has no edit-after-publish flow
       * on any platform yet, and claiming it here would be the only one.
       */
      edit: false,
      editOwnPostsOnly: false,
      /** Verified: `DELETE /v5/pins/{id}`, within the `pins:write` Orbit holds. */
      delete: true,
      readStatus: true,
    },

    publishing: {
      idempotencyKey: false,
      /** A pin can be read back by id, so an ambiguous create is answerable. */
      reconcilable: true,
      /**
       * Verified: 1,000 pin creates per user per day, and Pinterest returns
       * 429 with the standard rate-limit body when it is reached.
       */
      rateLimit: { maxPosts: 1000, windowMs: 24 * 60 * 60 * 1000 },
    },

    analytics: {
      post: true,
      /**
       * `GET /v5/user_account/analytics` exists but is scoped to business
       * accounts and reports on a different model. Not built, so not claimed.
       */
      account: false,
      metrics: [...PINTEREST_PIN_METRICS],
      deprecatedMetrics: [],
    },

    webhooks: { supported: false },
  });
}
