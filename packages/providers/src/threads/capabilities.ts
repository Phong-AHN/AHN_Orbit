import { defineCapabilities, type PlatformCapabilities } from '../capabilities.js';

/**
 * Threads capability descriptor (SRS §7).
 *
 * Threads is Meta's, and shares almost nothing with the Meta adapters already
 * here. Its own host (`graph.threads.net`), its own authorization window
 * (`threads.net`), its own app id and secret — Meta's own guide says a Threads
 * app issues **two** id/secret pairs and that the Threads one is the one to
 * use. Treating it as another Instagram surface would be wrong at every layer.
 *
 * What genuinely resembles Instagram is the publish shape: a container, then a
 * publish call. What differs is that Threads asks for a **deliberate wait**
 * between the two — Meta documents roughly 30 seconds — where Instagram
 * publishes an image container immediately.
 *
 * Sources are Meta's Threads API documentation. Anything not stated there is
 * marked UNVERIFIED, the same discipline the other descriptors follow.
 */

/** Verified: required for every Threads endpoint. */
export const THREADS_DEFAULT_SCOPES = ['threads_basic'] as const;

/** Verified: publishing needs this in addition to the baseline. */
export const THREADS_PUBLISH_SCOPES = ['threads_basic', 'threads_content_publish'] as const;

/**
 * Reading replies, which Orbit does not do yet.
 *
 * Named rather than requested: asking for permissions a product does not use is
 * how a consent screen grows scary and a review gets harder to pass.
 */
export const THREADS_REPLY_SCOPES = ['threads_manage_replies', 'threads_read_replies'] as const;

/** Verified: `graph.threads.net`, versioned in the path. */
export const THREADS_API_HOST = 'https://graph.threads.net';
export const THREADS_AUTHORIZE_URL = 'https://threads.net/oauth/authorize';

/**
 * Container states, as `GET /{container-id}?fields=status` reports them.
 *
 * `FINISHED` means ready to publish, not published — the same distinction
 * Instagram draws, and the same trap.
 */
export const THREADS_CONTAINER_STATUS = [
  'IN_PROGRESS',
  'FINISHED',
  'PUBLISHED',
  'ERROR',
  'EXPIRED',
] as const;
export type ThreadsContainerStatus = (typeof THREADS_CONTAINER_STATUS)[number];

/**
 * Metrics the insights endpoint serves per post.
 *
 * UNVERIFIED as a complete list. Reporting a metric Threads does not serve
 * shows as unavailable rather than zero, so an omission here is visible and a
 * fabrication would not be (SRS §18).
 */
export const THREADS_POST_METRICS = ['views', 'likes', 'replies', 'reposts', 'quotes'] as const;

export function threadsCapabilities(apiVersion: string): PlatformCapabilities {
  return defineCapabilities({
    platform: 'THREADS',
    accountType: null,
    apiVersion,
    verifiedOn: '2026-08-17',

    text: {
      supported: true,
      /**
       * Verified: 500 characters.
       *
       * The shortest limit of any platform here by a wide margin — Instagram
       * allows 2,200 and Facebook 63,206 — which is exactly why the composer's
       * per-account counter earns its place.
       */
      maxLength: 500,
      /**
       * Threads is the one platform here that publishes text on its own **and**
       * media on its own. `media_type: TEXT` is a first-class container.
       */
      allowsEmptyWithMedia: true,
    },

    /**
     * A link in a Threads post is a real link.
     *
     * The opposite of Instagram and TikTok, and worth stating: this is the only
     * platform here besides Facebook where putting a URL in the text does what
     * somebody expects.
     *
     * UNVERIFIED as a *count*: Meta documents no limit on links in a post. One
     * is the conservative reading and matches how the product renders a
     * preview card, but the platform is the authority.
     */
    link: { supported: true, maxCount: 1 },

    media: {
      /**
       * UNVERIFIED: byte ceiling and dimensions. Meta's Threads media
       * specification is not stated in the publishing guide, so a generous
       * ceiling is used and the platform stays the authority — an over-strict
       * guess refuses posts Threads accepts, which is the worse mistake.
       */
      image: {
        mimeTypes: ['image/jpeg', 'image/png'],
        maxBytes: 8 * 1024 * 1024,
      },
      video: {
        mimeTypes: ['video/mp4', 'video/quicktime'],
        // UNVERIFIED: 1 GB, matching Instagram's documented figure.
        maxBytes: 1024 * 1024 * 1024,
        // UNVERIFIED: no duration or frame-rate figures are documented for
        // Threads. Absent rather than guessed — a wrong ceiling here would
        // refuse valid video, and the platform reports its own refusal clearly.
      },
      gif: null,
      // Verified: a carousel holds 2–20 items.
      maxAttachments: 20,
      /**
       * UNVERIFIED: mixed carousels. Meta's guide says a carousel holds
       * "images and/or videos", which reads as permitting a mix, but it does
       * not say so outright. Permissive is the safer error here — the platform
       * refuses what it will not take, and being stricter than the platform
       * refuses posts it would have accepted.
       */
      allowsMixedKinds: true,
      carousel: true,
      // No alt-text parameter exists on the container endpoints.
      altText: false,
      // Text alone is a valid post.
      required: false,
    },

    hashtags: { supported: true },
    mentions: { supported: true },

    /** No first-comment endpoint; a reply is a separate post with its own id. */
    firstComment: { supported: false },

    scheduling: {
      // Threads publishes when `threads_publish` is called. Orbit's queue is the
      // only scheduler.
      providerSide: false,
    },

    lifecycle: {
      edit: false,
      editOwnPostsOnly: false,
      // The API offers no delete. Removing a post is a manual action.
      delete: false,
      readStatus: true,
    },

    publishing: {
      idempotencyKey: false,
      /**
       * The container id answers "did this go out?" directly, exactly as
       * TikTok's `publish_id` does — a stronger answer than searching a
       * timeline for something that resembles what we sent.
       */
      reconcilable: true,
      /**
       * Verified: 250 published posts per rolling 24 hours, per profile, with a
       * carousel counting as one.
       *
       * Meta asks integrators to enforce this themselves — "especially if it
       * allows app users to schedule posts for future publishing", which is
       * precisely what Orbit is. Expressed here as the engine's own budget so a
       * queue cannot drive an account into the ceiling.
       */
      rateLimit: { maxPosts: 250, windowMs: 24 * 60 * 60 * 1000 },
    },

    analytics: {
      post: true,
      /**
       * Threads serves account-level insights — follower counts and views —
       * unlike TikTok. Declaring it true means the sweep asks; a metric the API
       * declines shows as unavailable rather than zero.
       */
      account: true,
      metrics: [...THREADS_POST_METRICS],
      deprecatedMetrics: [],
    },

    webhooks: { supported: false },
  });
}
