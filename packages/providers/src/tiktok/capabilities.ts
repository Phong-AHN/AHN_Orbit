import { defineCapabilities, type PlatformCapabilities } from '../capabilities.js';

/**
 * TikTok capability descriptor (SRS §7).
 *
 * TikTok is the first platform in Orbit where **video is the point**, and the
 * first where a post is not finished when the API returns. Both facts are
 * declared here rather than special-cased anywhere else.
 *
 * Two things about this platform have no equivalent in the Meta adapters and
 * are worth stating before the numbers:
 *
 *   • **Publishing is asynchronous.** `video/init` returns a `publish_id`, not
 *     a post. The post exists only once `status/fetch` reports
 *     `PUBLISH_COMPLETE`, which can be many seconds later. `reconcilable` is
 *     true because that same `publish_id` answers "did it go out?" exactly.
 *
 *   • **The creator's privacy options are not ours to choose.** They come from
 *     `creator_info/query` per account, per moment, and TikTok treats ignoring
 *     them as a Terms of Service violation rather than a bad request. So the
 *     descriptor cannot hold them: they are fetched and shown, never assumed.
 *
 * Sources are TikTok's Content Posting API documentation. Anything not stated
 * outright there is marked UNVERIFIED, which is the same discipline the Meta
 * descriptors follow — a guess dressed as a fact is worse than an absent limit.
 */

/** Login Kit baseline plus what publishing needs. */
export const TIKTOK_DEFAULT_SCOPES = ['user.info.basic'] as const;

/**
 * Direct Post — the post lands on the profile.
 *
 * Verified: "Your app must be approved for the `video.publish` scope" and "the
 * target TikTok user must have authorized your app for the `video.publish`
 * scope".
 */
export const TIKTOK_PUBLISH_SCOPES = ['user.info.basic', 'video.publish'] as const;

/**
 * Upload to the creator's inbox — they finish the post in TikTok's editor.
 *
 * Verified: the upload guide requires `video.upload` rather than
 * `video.publish`, and needs no audit.
 */
export const TIKTOK_UPLOAD_SCOPES = ['user.info.basic', 'video.upload'] as const;

/** Reading back post metrics needs the user's video list. */
export const TIKTOK_ANALYTICS_SCOPES = ['video.list'] as const;

/**
 * Metrics the Display API serves per video.
 *
 * Verified against the `/v2/video/list/` and `/v2/video/query/` field list.
 * TikTok has no account-level insight endpoint on this API, which is why
 * `analytics.account` is false — reporting a fabricated account total would be
 * exactly the zero-instead-of-unavailable failure SRS §18 forbids.
 */
export const TIKTOK_VIDEO_METRICS = [
  'view_count',
  'like_count',
  'comment_count',
  'share_count',
] as const;

/**
 * What `status/fetch` can say about a publish in flight.
 *
 * `SEND_TO_USER_INBOX` is terminal *for upload mode only* — it means the
 * notification reached the creator, not that anything is live.
 */
export const TIKTOK_PUBLISH_STATUS = [
  'PROCESSING_UPLOAD',
  'PROCESSING_DOWNLOAD',
  'SEND_TO_USER_INBOX',
  'PUBLISH_COMPLETE',
  'FAILED',
] as const;

export type TikTokPublishStatus = (typeof TIKTOK_PUBLISH_STATUS)[number];

/**
 * How a post reaches TikTok. Chosen per variant, because the two modes make
 * genuinely different promises and only the person composing knows which one
 * they mean.
 */
export const TIKTOK_POST_MODES = ['DIRECT_POST', 'MEDIA_UPLOAD'] as const;
export type TikTokPostMode = (typeof TIKTOK_POST_MODES)[number];

/**
 * Privacy levels TikTok defines.
 *
 * **This list is not a menu.** Which of these an account may actually use comes
 * from `creator_info/query` at compose time and changes with the creator's own
 * settings — a private account cannot post publicly at all. The array exists so
 * a stored value can be validated as a known string, never to populate a
 * dropdown.
 */
export const TIKTOK_PRIVACY_LEVELS = [
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
] as const;

export type TikTokPrivacyLevel = (typeof TIKTOK_PRIVACY_LEVELS)[number];

/** Chunk rules for FILE_UPLOAD, verified in the Media Transfer Guide. */
export const TIKTOK_CHUNK = {
  minBytes: 5 * 1024 * 1024,
  maxBytes: 64 * 1024 * 1024,
  /** The final chunk absorbs trailing bytes and may reach this. */
  finalMaxBytes: 128 * 1024 * 1024,
  maxCount: 1000,
} as const;

export function tiktokCapabilities(apiVersion: string): PlatformCapabilities {
  return defineCapabilities({
    platform: 'TIKTOK',
    accountType: null,
    apiVersion,
    verifiedOn: '2026-08-17',

    text: {
      supported: true,
      /**
       * Verified for photo posts: "The maximum length for photo posts is 4000
       * in UTF-16 runes" for `description`. The video caption limit is not
       * stated in the posting docs; 2,200 is the commonly cited figure and the
       * shorter of the two, so it is the safe ceiling to enforce.
       *
       * UNVERIFIED: the 2,200 video figure.
       */
      maxLength: 2_200,
      // A TikTok post is the video. A caption is optional.
      allowsEmptyWithMedia: true,
    },

    /**
     * A URL in a TikTok caption is not a link.
     *
     * It renders as plain text for everyone without a link-in-bio privilege,
     * so offering a link field would promise something the platform does not
     * do — the same call the Instagram descriptor makes, for the same reason.
     */
    link: { supported: false, maxCount: 0 },

    media: {
      /**
       * Photo posts go through `/v2/post/publish/content/init/` with
       * `media_type: PHOTO`, which is a different endpoint from video.
       *
       * UNVERIFIED: byte ceiling and minimum dimensions. TikTok's photo
       * restrictions page is referenced by the posting guide but does not state
       * figures in it, so a generous ceiling is used and the platform remains
       * the authority — an over-strict guess would refuse posts TikTok accepts.
       */
      image: {
        mimeTypes: ['image/jpeg', 'image/webp'],
        maxBytes: 20 * 1024 * 1024,
      },

      /**
       * Verified: "MP4 + H.264" is the format the posting guide names.
       * `video/quicktime` is accepted by the upload endpoint in practice.
       *
       * **`maxDurationMs` is deliberately absent.** The real ceiling is
       * `max_video_post_duration_sec` from `creator_info/query`, which differs
       * per creator — 60s for some accounts, 600s for others. A number here
       * would be wrong for most accounts in one direction or the other, and the
       * pre-flight check reads the creator's own figure instead.
       *
       * UNVERIFIED: the 4 GB ceiling.
       */
      video: {
        mimeTypes: ['video/mp4', 'video/quicktime'],
        maxBytes: 4 * 1024 * 1024 * 1024,
        minDurationMs: 3_000,
      },

      gif: null,
      // Verified: a photo post carries up to 35 images.
      maxAttachments: 35,
      // A TikTok post is a video *or* a photo set, never both.
      allowsMixedKinds: false,
      carousel: true,
      // No alt-text field exists on either init endpoint.
      altText: false,
      // There is no such thing as a text-only TikTok post.
      required: true,
    },

    hashtags: { supported: true },

    /**
     * `@mentions` work inside the caption text and need no separate API.
     * Nothing has to be resolved to an id first, unlike Instagram's tagging.
     */
    mentions: { supported: true },

    /**
     * No first-comment endpoint exists on the Content Posting API. Hashtags go
     * in the caption on TikTok anyway, which is where creators put them.
     */
    firstComment: { supported: false },

    scheduling: {
      // TikTok publishes when we call init, not at a time we hand over. Orbit's
      // queue is the only scheduler.
      providerSide: false,
    },

    lifecycle: {
      // The Content Posting API has no edit endpoint.
      edit: false,
      editOwnPostsOnly: false,
      // Nor a delete. Removing a post is a manual action in the app.
      delete: false,
      /**
       * `status/fetch` reads a *publish* back, and `video/query` reads a
       * published video back. Both exist, which is what makes reconciliation
       * possible rather than a guess.
       */
      readStatus: true,
    },

    publishing: {
      // No client-supplied idempotency key. `publish_id` is issued by TikTok.
      idempotencyKey: false,
      /**
       * True, and stronger than Instagram's: `status/fetch` answers about
       * *this exact attempt* rather than requiring a listing to be searched for
       * something that looks like ours.
       */
      reconcilable: true,
      /**
       * Verified: "Each user access_token is limited to 6 requests per minute"
       * on the posting endpoints. This is the *publish* budget, and the tighter
       * of the documented figures — the status endpoint allows more.
       */
      rateLimit: { maxPosts: 6, windowMs: 60_000 },
    },

    analytics: {
      post: true,
      /**
       * False, and deliberately.
       *
       * The Display API serves per-video counters and nothing at account level:
       * no reach, no profile views, no follower series. Declaring `true` and
       * summing videos would produce a number that looks like an account metric
       * and is not one — which is precisely the fabrication SRS §18 forbids.
       */
      account: false,
      metrics: [...TIKTOK_VIDEO_METRICS],
      deprecatedMetrics: [],
    },

    webhooks: { supported: false },
  });
}
