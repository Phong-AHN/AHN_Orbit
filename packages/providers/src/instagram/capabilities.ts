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
 * Scopes for reading and answering comments — **two names for one capability.**
 *
 * Instagram splits this by connection flow, and the names are not
 * interchangeable:
 *
 * | Flow | Host | Scope |
 * |---|---|---|
 * | Facebook Login (`INSTAGRAM_BUSINESS`) | `graph.facebook.com` | `instagram_manage_comments` |
 * | Business Login (`INSTAGRAM_LOGIN`) | `graph.instagram.com` | `instagram_business_manage_comments` |
 *
 * Which is why the descriptor has to vary by account type rather than listing
 * both: a connection only ever holds one of them, so a `replyScopes` naming
 * both would refuse every reply as "needs reconnecting" — on an account that
 * is correctly connected.
 *
 * Both cover reading, replying, hiding and deleting. Orbit asks for them to
 * read and reply; it does not hide or delete, and the descriptor says so with
 * `moderate: false`.
 */
export const INSTAGRAM_COMMENT_SCOPES = ['instagram_manage_comments'] as const;
export const INSTAGRAM_LOGIN_COMMENT_SCOPES = ['instagram_business_manage_comments'] as const;

/**
 * Scopes for reading insights — **split by flow, like comments.**
 *
 * | Flow | Scope |
 * |---|---|
 * | Facebook Login | `instagram_manage_insights` |
 * | Business Login | `instagram_business_manage_insights` |
 *
 * This file previously asserted that Instagram needed *no* separate insights
 * scope — that metrics came with `instagram_basic` and the Page token, unlike
 * Facebook's `read_insights`. That was wrong, and wrong in the direction that
 * does not announce itself: the token still reads media *fields* perfectly
 * well and fails only on the metrics call, so publishing worked and analytics
 * would have returned a permission error for every account.
 *
 * Meta's Instagram Platform insights reference lists the requirement plainly:
 * `instagram_basic`, `instagram_manage_insights` and `pages_read_engagement`
 * for Facebook Login; `instagram_business_basic` and
 * `instagram_business_manage_insights` for Business Login.
 *
 * **Not included, and a decision rather than an omission:** that same page adds
 * `ads_management` and `ads_read` *if the app user holds their Page role
 * through Business Manager* — which for an agency is the normal case, not the
 * exception. They are left out because advertising permissions widen an App
 * Review considerably and Orbit touches no ad object; the consequence is that
 * an account whose Page role came via Business Manager may still be refused
 * insights. Recorded in `OWNER-TODO.md` §1 as something to decide with eyes
 * open, not discovered later from an empty chart.
 */
export const INSTAGRAM_INSIGHTS_SCOPES = ['instagram_manage_insights'] as const;
export const INSTAGRAM_LOGIN_INSIGHTS_SCOPES = ['instagram_business_manage_insights'] as const;

/**
 * Everything asked for at connect time: publish, comments and insights.
 *
 * Each of the three capabilities the descriptor claims has a scope here, which
 * is the invariant worth stating out loud — the insights one was missing for
 * months because nothing tied the two together, and `instagram.test.ts` now
 * asserts the link rather than the literal list.
 *
 * **A scope cannot be added to a grant already issued.** So an account
 * connected before any of these were requested has to be reconnected before
 * the capability works, and the product says which in advance rather than
 * failing at the button. That lesson came from `read_insights` on the Facebook
 * side; it is applied here early, while asking costs nothing.
 *
 * Declaration order matters: this spreads two top-level `const`s, so both have
 * to be declared above. Below them this is a module-load ReferenceError, which
 * no type check catches.
 */
export const INSTAGRAM_DEFAULT_SCOPES = [
  ...INSTAGRAM_PUBLISH_SCOPES,
  ...INSTAGRAM_COMMENT_SCOPES,
  ...INSTAGRAM_INSIGHTS_SCOPES,
] as const;

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
  ...INSTAGRAM_LOGIN_COMMENT_SCOPES,
  ...INSTAGRAM_LOGIN_INSIGHTS_SCOPES,
] as const;

/**
 * Metrics the Instagram Graph API exposes for a published media object.
 *
 * UNVERIFIED as a set: Meta reshuffles these more often than the Pages
 * equivalents, and several were renamed in 2024. Narrow on purpose — a metric
 * we do not claim simply is not offered, which is recoverable; a metric we
 * claim and cannot fetch reads as a broken integration.
 */
/**
 * Media metrics, at v25.0.
 *
 * `views` is the one that matters and it is *new*: Meta introduced it in the
 * v22.0 changelog as the single replacement for the play-and-impression family,
 * and deprecated that whole family on 2025-04-21. Reading Instagram performance
 * on this version means reading `views` — an implementation carried over from a
 * pre-v22 tutorial asks for `impressions` and gets an error, not a zero.
 */
const AVAILABLE_METRICS = ['views', 'reach', 'likes', 'comments', 'saved', 'shares'] as const;

/**
 * Account-level metrics, which are **not** the media-level ones (verified
 * 2026-08-14 against Meta's Instagram User Insights reference).
 *
 * Two differences matter enough to spell out, because assuming parity with
 * either Facebook or with `AVAILABLE_METRICS` above produces a call that fails:
 *
 * 1. **The spelling differs by level.** Media insights use `saved`; account
 *    insights use `saves`. The same concept, two names, and asking the wrong
 *    one is an invalid-metric error rather than an empty result.
 * 2. **Account metrics need `metric_type=total_value`.** Without it Graph
 *    returns a time series, and several of these have no time-series form at
 *    all.
 *
 * Deliberately excluded, and why — this list is short on purpose:
 *
 * - `follower_demographics`, `engaged_audience_demographics` — `lifetime`
 *   period with a `timeframe` parameter, a different call shape entirely, and
 *   they carry a **100-follower minimum**.
 * - `follows_and_unfollows` — same 100-follower minimum. A new client account
 *   with forty followers would error, and one bad metric in a batch fails the
 *   whole request, which would leave that account with *no* analytics rather
 *   than one missing number.
 * - `replies`, `reposts` — story and DM oriented; nothing in the product reads
 *   them yet, and an unread metric is still a quota cost on every poll.
 */
const ACCOUNT_METRICS = [
  'reach',
  'views',
  'likes',
  'saves',
  'shares',
  'comments',
  'total_interactions',
  'profile_links_taps',
  'accounts_engaged',
] as const;

export const INSTAGRAM_ACCOUNT_METRICS = ACCOUNT_METRICS;

/**
 * Withdrawn for media objects; kept so a stored snapshot stays explicable.
 *
 * The last four went on 2025-04-21 with v22.0. `impressions` is a special case:
 * Meta continues to return it for media created on or before 2024-07-01, which
 * makes it exactly the kind of metric that looks alive in a spot check and is
 * dead for anything published since.
 */
const DEPRECATED_METRICS = [
  'impressions',
  'engagement',
  'plays',
  'clips_replays_count',
  'ig_reels_aggregated_all_plays_count',
] as const;

/**
 * The descriptor, which now genuinely depends on the account type.
 *
 * It did not before: one cached `INSTAGRAM_BUSINESS` descriptor served both
 * connection flows, which was harmless while everything it described was
 * identical in shape and differed only in host. Comments broke that — the
 * scope name differs per flow — so the parameter the interface always declared
 * is finally used.
 */
export function instagramCapabilities(
  apiVersion: string,
  accountType: 'INSTAGRAM_BUSINESS' | 'INSTAGRAM_LOGIN' = 'INSTAGRAM_BUSINESS',
): PlatformCapabilities {
  const isLogin = accountType === 'INSTAGRAM_LOGIN';

  return defineCapabilities({
    platform: 'INSTAGRAM',
    accountType,
    apiVersion,
    verifiedOn: '2026-08-14',

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
      /**
       * Video means **Reels**: `media_type=REELS` on the container.
       *
       * Instagram retired the standalone video post — everything vertical is a
       * Reel now — so there is one video path and it is this one.
       *
       * Two constraints Meta documents that are *not* expressible here, and are
       * therefore worth stating: the container must have **`moov` at the front
       * of the file** (fast-start), and edit lists are refused. Both are
       * properties of how the file was written rather than of its dimensions,
       * and both produce a container that reports ERROR rather than a
       * pre-flight failure.
       */
      video: {
        mimeTypes: ['video/mp4', 'video/quicktime'],
        // Verified: 1 GB.
        maxBytes: 1024 * 1024 * 1024,
        // Verified: 3 seconds to 15 minutes. Only 5–90s reaches the Reels tab,
        // which is a distribution matter rather than an accepted/refused one,
        // so it is not enforced here.
        minDurationMs: 3_000,
        maxDurationMs: 15 * 60 * 1000,
        // Verified: 23–60 fps.
        minFrameRate: 23,
        maxFrameRate: 60,
        /**
         * No aspect constraint, deliberately.
         *
         * Meta accepts 0.01:1 to 10:1 and merely *recommends* 9:16. Enforcing
         * the recommendation would refuse posts Instagram publishes happily —
         * the opposite mistake from Facebook Reels, where vertical really is
         * required.
         */
      },
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
    engagement: {
      readComments: true,
      reply: true,
      // `POST /{ig-comment-id}/replies` threads the reply under the comment it
      // answers, which is what notifies the person who wrote it. A comment
      // posted on the media instead is a new top-level comment nobody sees.
      threadedReply: true,
      // Hiding and deleting are both covered by the scope and deliberately not
      // claimed: the product has no moderation UI, and a descriptor that says
      // yes invites the engine to call a method nothing implements.
      moderate: false,
      // Same as a caption. Checked before the call so an over-long reply is
      // refused with a number rather than a platform error.
      maxReplyLength: 2_200,
      replyScopes: isLogin ? INSTAGRAM_LOGIN_COMMENT_SCOPES : INSTAGRAM_COMMENT_SCOPES,
    },

    webhooks: { supported: false },
  });
}
