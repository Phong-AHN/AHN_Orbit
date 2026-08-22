import { defineCapabilities, type PlatformCapabilities } from '../capabilities.js';

/**
 * Facebook Page capabilities.
 *
 * Every value here is either verified against Meta's documentation (see
 * docs/SOCIAL_PROVIDERS.md §5 for links) or marked below as UNVERIFIED with a
 * conservative placeholder. SRS §46.I forbids claiming a capability we have not
 * checked, so the unverified ones are deliberately strict — they can only cause
 * a valid post to be questioned, never an invalid one to be sent.
 */

/** Scopes required to publish. All gated behind Meta App Review. */
export const FACEBOOK_PUBLISH_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
] as const;

/**
 * Scopes required to *read back* how a post did.
 *
 * These were the missing half. `read_insights` was declared here and then
 * **never requested by anything** — a dead constant — so Page Insights was
 * asked for with a token that had no insights permission. And reading a post's
 * reactions or comments needs `pages_read_user_content`, which was not named at
 * all: Meta refuses `comments.summary(true)` with *"(#10) requires the
 * 'pages_read_user_content' permission"* and the account looks healthy the whole
 * time, because publishing never touches it.
 *
 * Asked for at connect time rather than on demand — a scope cannot be added to
 * a grant that has already been issued, so an account connected before this
 * change has to be reconnected.
 */
export const FACEBOOK_ANALYTICS_SCOPES = ['read_insights', 'pages_read_user_content'] as const;

/** @deprecated Superseded by `FACEBOOK_ANALYTICS_SCOPES`, which is requested. */
export const FACEBOOK_INSIGHTS_SCOPE = 'read_insights';

export const FACEBOOK_DEFAULT_SCOPES = [
  ...FACEBOOK_PUBLISH_SCOPES,
  ...FACEBOOK_ANALYTICS_SCOPES,
] as const;

/**
 * Page Insights metrics, post-deprecation.
 *
 * `page_impressions` and `page_fans` were withdrawn on 2025-11-15 and now
 * return an invalid-metric *error* rather than an empty result — an
 * implementation written from older tutorials simply fails at runtime.
 * A further wave landed 2026-06-15 (docs/SOCIAL_PROVIDERS.md §3), and the
 * v25.0 changelog announces another for v26.0 — those names are listed as
 * deprecated below *before* they break, so nothing gets built on one.
 */
/**
 * Engagement counters, which do **not** come from Page Insights.
 *
 * Facebook keeps these on the post object — `likes.summary(true)`,
 * `comments.summary(true)`, `shares` — and `/insights` has never carried them.
 * Reported here so the composer and the analytics table treat them like any
 * other metric, but `fetchPostAnalytics` fetches them from a different edge.
 *
 * This is the gap that made a post with visible likes and comments read as
 * "not measured yet": every number a person could see on Facebook lived on the
 * one edge Orbit never asked for.
 */
export const FACEBOOK_ENGAGEMENT_METRICS = [
  'post_reactions',
  'post_comments',
  'post_shares',
] as const;

const AVAILABLE_METRICS = [
  ...FACEBOOK_ENGAGEMENT_METRICS,
  'page_media_view',
  'post_media_view',
  'page_total_media_view_unique',
  'post_total_media_view_unique',
  'page_follows',
  'page_follows_city',
  'page_follows_country',
  'page_post_engagements',
  'post_reactions_by_type_total',
  'post_clicks',
] as const;

const DEPRECATED_METRICS = [
  'page_impressions',
  'page_impressions_unique',
  'page_impressions_paid',
  'page_fans',
  'page_fans_city',
  'page_fans_country',
  'post_impressions',
  'post_impressions_unique',
  'post_impressions_paid',
  'post_impressions_fan',
  'page_engaged_users',
  'page_positive_feedback_by_type',

  // Announced in the v25.0 changelog as going when v26.0 ships later in 2026.
  // Listed now rather than when they break: the whole point of this array is
  // that Phase 3 can see which names are a dead end before building on one.
  // The stated replacement for the `*_impressions_unique` pair is
  // `page_total_media_view_unique` / `post_total_media_view_unique`, both of
  // which are already in AVAILABLE_METRICS above.
  'page_posts_impressions',
  'post_video_views_unique',
  'total_video_impressions',
  'total_video_impressions_unique',
] as const;

export function facebookPageCapabilities(apiVersion: string): PlatformCapabilities {
  return defineCapabilities({
    platform: 'FACEBOOK',
    accountType: 'PAGE',
    apiVersion,
    verifiedOn: '2026-08-12',

    text: {
      supported: true,
      // UNVERIFIED: 63,206 is the widely cited figure but is not stated in the
      // Pages API reference. Conservative until confirmed — see
      // docs/SOCIAL_PROVIDERS.md §6.
      maxLength: 63_206,
      allowsEmptyWithMedia: true,
    },

    link: { supported: true, maxCount: 10 },

    media: {
      // UNVERIFIED: Meta does not publish a single photo-size table for the
      // Pages API. These bounds are deliberately generous-but-finite.
      image: {
        mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
        maxBytes: 10 * 1024 * 1024,
        minWidth: 200,
        minHeight: 200,
      },
      /**
       * Video means **Reels**, and only Reels.
       *
       * The Page Video API can also take a plain feed video, but Meta has spent
       * three years moving everything to Reels and the Reels endpoint is the
       * one with a documented, current contract. Supporting both would double
       * the publish paths for a format Meta is retiring.
       *
       * Verified against Meta's Reels publishing guide.
       */
      video: {
        mimeTypes: ['video/mp4'],
        // UNVERIFIED: Meta documents no byte ceiling for Reels. 1 GB matches
        // Instagram's documented limit and is generous for a 90-second clip.
        maxBytes: 1024 * 1024 * 1024,
        // Verified: 3–90 seconds.
        minDurationMs: 3_000,
        maxDurationMs: 90_000,
        // Verified: 24–60 fps. Note this floor is *higher* than Instagram's and
        // TikTok's 23 — a 23.976fps film-rate export passes there and fails here.
        minFrameRate: 24,
        maxFrameRate: 60,
        // Verified: minimum 540×960, 1080×1920 recommended.
        minWidth: 540,
        minHeight: 960,
        /**
         * Verified: 9:16, which is 0.5625.
         *
         * A tolerance rather than the exact figure, because an export at
         * 1080×1921 is 0.5622 and is not what this check exists to catch. What
         * it catches is landscape or square footage sent to a vertical-only
         * surface, where the number is not close at all.
         */
        minAspectRatio: 0.5,
        maxAspectRatio: 0.62,
      },
      gif: null,
      // UNVERIFIED: attachment ceiling for a multi-photo feed post.
      maxAttachments: 10,
      allowsMixedKinds: false,
      // Facebook has no carousel post type; a multi-photo post is the closest
      // analogue, so the composer must not offer one.
      carousel: false,
      altText: true,
      required: false,
    },

    hashtags: { supported: true },
    mentions: { supported: false },

    // Requires pages_manage_engagement, which is not in our review submission.
    firstComment: { supported: false },

    scheduling: {
      // published=false + scheduled_publish_time. Verified window: 10 minutes
      // to 30 days. Orbit schedules through its own queue regardless; this is
      // a fallback only, and the 30-day ceiling is why.
      providerSide: true,
      minLeadMs: 10 * 60 * 1000,
      maxLeadMs: 30 * 24 * 60 * 60 * 1000,
    },

    lifecycle: {
      edit: true,
      // "An app can only update a Page post if the post was made using that
      // app." Verified. The composer explains rather than failing.
      editOwnPostsOnly: true,
      delete: true,
      readStatus: true,
    },

    publishing: {
      // /{page-id}/feed accepts no client idempotency key — the sole reason
      // reconcile() exists (docs/ARCHITECTURE.md §5.2 layer 4).
      idempotencyKey: false,
      reconcilable: true,
      // UNVERIFIED for standard feed posts. The 30/24h figure is verified for
      // Reels only, so no cap is claimed here.
      rateLimit: null,
    },

    analytics: {
      post: true,
      account: true,
      metrics: [...AVAILABLE_METRICS],
      deprecatedMetrics: [...DEPRECATED_METRICS],
    },

    webhooks: { supported: true },
  });
}
