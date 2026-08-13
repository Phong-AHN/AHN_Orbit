import { defineCapabilities, type PlatformCapabilities } from '../capabilities.js';

/**
 * Instagram professional-account capabilities.
 *
 * Same rule as the Facebook descriptor: every value is either verified against
 * Meta's documentation or marked UNVERIFIED with a conservative placeholder
 * (SRS §46.I). An unverified bound can only cause a valid post to be
 * questioned, never an invalid one to be sent.
 *
 * The permission list *is* verified — it is the set Meta's own use-case setup
 * adds by default for "API setup with Facebook Login", content management.
 */

/**
 * The permissions the Instagram use case needs for content management.
 *
 * **`instagram_content_publish`, not `instagram_content_publishing`.** Meta's
 * own use-case setup page writes it with the `-ing`, and the OAuth dialog
 * rejects that outright:
 *
 *   Invalid Scope: instagram_content_publishing
 *   (Please check lower letter case or delimiter)
 *
 * The Permissions Reference is the authority here, and it has no `-ing` form.
 * Verified against the dialog, which is the only test that counts — a scope
 * string is not checkable by types or by us, only by Meta.
 */
export const INSTAGRAM_PUBLISH_SCOPES = [
  'business_management',
  'instagram_basic',
  'instagram_content_publish',
  'pages_read_engagement',
  'pages_show_list',
] as const;

/**
 * No separate insights scope.
 *
 * Instagram post and account metrics are read with `instagram_basic` plus the
 * Page token, unlike Facebook where `read_insights` is its own permission.
 */
export const INSTAGRAM_DEFAULT_SCOPES = INSTAGRAM_PUBLISH_SCOPES;

/**
 * The two ways an Instagram account can be reached.
 *
 * `INSTAGRAM_BUSINESS` — through the Facebook Page it is linked to. Meta calls
 * this "API setup with Facebook Login". One consent covers the Page and the
 * Instagram account, and it needs a linked Page.
 *
 * `INSTAGRAM_LOGIN` — Business Login for Instagram: the person signs in with
 * their Instagram username. No Page required, and it needs a **separate Meta
 * app**, because Meta allows one API setup per app.
 */
export const INSTAGRAM_ACCOUNT_TYPES = ['INSTAGRAM_BUSINESS', 'INSTAGRAM_LOGIN'] as const;
export type InstagramAccountType = (typeof INSTAGRAM_ACCOUNT_TYPES)[number];

/**
 * Scopes for Business Login for Instagram.
 *
 * A different namespace from the Facebook-Login ones — `instagram_business_*`,
 * not `instagram_*` — and **not verifiable from our side**. The `-ing` incident
 * with `instagram_content_publish` is the reason this says so out loud: a scope
 * string type-checks, passes every test here, and is judged only by Meta's
 * dialog. Confirm each against the Permissions Reference before submitting.
 */
export const INSTAGRAM_LOGIN_SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
] as const;

/**
 * Metrics the Instagram Graph API exposes for a published media object.
 *
 * UNVERIFIED as a set: Meta reshuffles these more often than the Pages
 * equivalents, and several were renamed in 2024. Narrow on purpose — a metric
 * we do not claim simply is not offered, which is recoverable; a metric we
 * claim and cannot fetch reads as a broken integration.
 */
const AVAILABLE_METRICS = ['reach', 'likes', 'comments', 'saved', 'shares'] as const;

/** Withdrawn for media objects; kept so a stored snapshot stays explicable. */
const DEPRECATED_METRICS = ['impressions', 'engagement'] as const;

export function instagramCapabilities(apiVersion: string): PlatformCapabilities {
  return defineCapabilities({
    platform: 'INSTAGRAM',
    accountType: 'INSTAGRAM_BUSINESS',
    apiVersion,
    verifiedOn: '2026-08-13',

    text: {
      supported: true,
      // Verified: the caption limit for a media object.
      maxLength: 2_200,
      // A caption may be empty, but only because media carries the post.
      allowsEmptyWithMedia: true,
    },

    /**
     * Instagram does not linkify captions.
     *
     * A URL in a caption renders as plain text, so offering a link field would
     * promise something the platform does not do. The composer shows the
     * difference rather than letting someone discover it after publishing.
     */
    link: { supported: false, maxCount: 0 },

    media: {
      /**
       * JPEG only, and now verified rather than inferred.
       *
       * Meta's Content Publishing guide states it outright: "JPEG is the only
       * image format supported. Extended JPEG formats such as MPO and JPS are
       * not supported." So refusing a PNG in the composer is not caution — it
       * is the platform's rule, applied where the person can still act on it.
       */
      image: {
        mimeTypes: ['image/jpeg'],
        // UNVERIFIED: 8 MB is the commonly cited ceiling.
        maxBytes: 8 * 1024 * 1024,
        minWidth: 320,
        minHeight: 320,
      },
      // Reels go through a separate container type with its own upload flow.
      // Not built, so publishing refuses video outright.
      video: null,
      gif: null,
      // Verified: a carousel holds 2–10 items.
      maxAttachments: 10,
      allowsMixedKinds: false,
      // Unlike Facebook, multiple images *are* a first-class carousel here.
      carousel: true,
      altText: true,
      /**
       * The one capability that changes how the product behaves.
       *
       * Instagram cannot publish text alone. A post targeting both Facebook and
       * Instagram with no image is valid for one and invalid for the other —
       * which the per-variant validation already surfaces, because each variant
       * is checked against its own platform.
       */
      required: true,
    },

    hashtags: { supported: true, maxCount: 30 },
    // Tagging another account requires the tagging API, not a caption mention.
    mentions: { supported: false },

    /**
     * The first comment is where hashtags usually go on Instagram, and the
     * Content Publishing API cannot post one — `/{ig-media-id}/comments`
     * needs `instagram_manage_comments`, which is a different use case and not
     * in our review submission.
     */
    firstComment: { supported: false },

    scheduling: {
      // No provider-side scheduling at all: a container is published when we
      // call media_publish, not at a time we hand over. Orbit's queue is the
      // only scheduler, so there is no lead-time window to warn about.
      providerSide: false,
    },

    lifecycle: {
      // A caption cannot be changed through the API once published.
      edit: false,
      // Meaningless while editing is unsupported, and the descriptor's own
      // coherence check refuses the combination.
      editOwnPostsOnly: false,
      /**
       * Verified: the Instagram Graph API exposes no delete for media. Removing
       * a post is a manual action in the app, and `deletePost` says so rather
       * than failing with something that reads like an outage.
       */
      delete: false,
      readStatus: true,
    },

    publishing: {
      // No client idempotency key, same as Pages — hence reconcile().
      idempotencyKey: false,
      reconcilable: true,
      /**
       * 100 per rolling 24 hours, and a carousel counts as one.
       *
       * I had 25 here, which was wrong. Meta's Content Publishing guide is
       * itself inconsistent — the Rate Limit section says 100, the carousel
       * section says 50 — so the higher, primary figure is used and the
       * conflict is recorded rather than quietly averaged. Being generous is
       * the safe direction for a *ceiling*: Meta enforces the real one on
       * `media_publish` regardless, and a limit we set too low would refuse
       * posts the platform would have accepted.
       *
       * `GET /{ig-user-id}/content_publishing_limit` reports actual usage and
       * is the honest source if this ever needs to be exact.
       */
      rateLimit: { maxPosts: 100, windowMs: 24 * 60 * 60 * 1000 },
    },

    analytics: {
      post: true,
      account: true,
      metrics: [...AVAILABLE_METRICS],
      deprecatedMetrics: [...DEPRECATED_METRICS],
    },

    // Instagram webhooks exist but need their own subscription and a published
    // app; not wired, so nothing claims to receive them.
    webhooks: { supported: false },
  });
}
