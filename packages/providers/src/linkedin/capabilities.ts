import { defineCapabilities, type PlatformCapabilities } from '../capabilities.js';

/**
 * LinkedIn capability descriptor (SRS §7).
 *
 * The sixth platform, and the least like the other five. LinkedIn is a
 * versioned REST API rather than a Graph: every call carries a
 * `LinkedIn-Version: YYYYMM` header and a `X-Restli-Protocol-Version` header,
 * and a version is **sunset roughly a year after release**. That is a
 * deployment obligation, not a detail — an unattended integration stops working
 * on a date LinkedIn has already published.
 *
 * Two things here exist nowhere else in the product:
 *
 *   • **A post can be deleted.** Every other platform Orbit speaks to refuses,
 *     and the composer has always had to explain that. LinkedIn returns 204.
 *   • **The post id arrives in a response header** (`x-restli-id`), not in the
 *     body. Reading the body for it yields nothing and looks like a platform
 *     fault.
 */

/**
 * The API version this adapter is written against.
 *
 * Pinned rather than floating: LinkedIn changes field shapes between versions,
 * and "latest" would mean the integration changes under us on their schedule.
 * Bumping it is a deliberate act with a changelog to read first.
 */
export const LINKEDIN_VERSION = '202608';

export const LINKEDIN_API_HOST = 'https://api.linkedin.com';
export const LINKEDIN_AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization';
export const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';

/**
 * Scopes for posting as a company page, which is what an agency does.
 *
 * Verified: `w_organization_social` is "post, comment, and like posts on behalf
 * of an organization", and is restricted to pages where the authenticated
 * member holds ADMINISTRATOR, DIRECT_SPONSORED_CONTENT_POSTER or CONTENT_ADMIN.
 * A member who administers no page can authorise successfully and still have
 * nothing to connect — which the connect flow reports rather than returning an
 * empty list silently.
 */
export const LINKEDIN_PUBLISH_SCOPES = [
  'openid',
  'profile',
  'w_member_social',
  'w_organization_social',
  'r_organization_social',
] as const;

/** Roles on a company page that permit publishing. */
export const LINKEDIN_PUBLISHING_ROLES = [
  'ADMINISTRATOR',
  'DIRECT_SPONSORED_CONTENT_POSTER',
  'CONTENT_ADMIN',
] as const;

export function linkedinCapabilities(apiVersion: string): PlatformCapabilities {
  return defineCapabilities({
    platform: 'LINKEDIN',
    accountType: null,
    apiVersion,
    verifiedOn: '2026-08-18',

    text: {
      supported: true,
      /**
       * UNVERIFIED: LinkedIn's error table names `FIELD_LENGTH_TOO_LONG` for
       * `commentary` without stating the ceiling. 3,000 is the figure the
       * product enforces in its own composer and the one every integration
       * uses; the platform remains the authority and reports its own refusal.
       */
      maxLength: 3_000,
      allowsEmptyWithMedia: true,
    },

    /**
     * A link is a first-class post type here — an "article" post with a
     * thumbnail, title and description.
     *
     * Verified, and with a constraint worth stating: **LinkedIn does not scrape
     * the URL.** The docs say so outright, because scraping "introduces
     * unpredictability in how a post will appear". Title and description have
     * to be supplied, and a bare URL in the text is just text.
     */
    link: { supported: true, maxCount: 1 },

    media: {
      /**
       * Verified: JPG, GIF and PNG, under 36,152,320 pixels.
       *
       * The limit is a **pixel count**, not a byte count — unusual enough that
       * it is expressed as dimensions here, since that is what the shared
       * validator can check. 36,152,320 is roughly 6000×6000.
       *
       * UNVERIFIED: the byte ceiling, which LinkedIn does not state.
       */
      image: {
        mimeTypes: ['image/jpeg', 'image/png', 'image/gif'],
        maxBytes: 20 * 1024 * 1024,
        maxWidth: 6_000,
        maxHeight: 6_000,
      },

      /**
       * Video is **not built**, and that is a decision rather than an oversight.
       *
       * LinkedIn's Videos API is a separate multipart upload flow with its own
       * initialize/upload/finalize shape — closer to TikTok's chunking than to
       * anything Meta does. Declaring a constraint here without building that
       * path would let the composer accept a video the worker then refuses,
       * which is precisely the web-says-valid/worker-says-no split this
       * descriptor exists to prevent.
       */
      video: null,
      gif: null,

      /**
       * One image per post, for now.
       *
       * Verified: multiple images on an organic post need the **MultiImage
       * API**, a different endpoint with a different body. `maxAttachments: 1`
       * is the honest description of what this adapter builds; claiming more
       * would refuse at publish time what the composer accepted.
       */
      maxAttachments: 1,
      allowsMixedKinds: false,
      carousel: false,
      /** Verified: `content.media.altText`, up to 4,086 characters. */
      altText: true,
      required: false,
    },

    /** Plain `#tag` in the commentary works; LinkedIn renders it as a hashtag. */
    hashtags: { supported: true },

    /**
     * Mentions need the entity's URN, not just a name:
     * `@[Devtestco](urn:li:organization:2414183)`, and the text must match the
     * entity's name exactly or it renders as ordinary text. Orbit has no URN
     * lookup, so this is declared unsupported rather than half-working.
     */
    mentions: { supported: false },

    /** A comment is a separate API call against the post; not built. */
    firstComment: { supported: false },

    scheduling: { providerSide: false },

    lifecycle: {
      /**
       * Verified: `PARTIAL_UPDATE` can change `commentary`. Not offered yet —
       * Orbit has no edit-after-publish flow, and declaring it true would put a
       * button on screen with nothing behind it.
       */
      edit: false,
      editOwnPostsOnly: false,
      /**
       * **True, and unique here.** `DELETE /rest/posts/{urn}` returns 204, and
       * deletions are idempotent. Every other platform in the product refuses,
       * so this is the one place the composer's "this cannot be undone" caveat
       * does not apply.
       */
      delete: true,
      readStatus: true,
    },

    publishing: {
      idempotencyKey: false,
      /** A post can be fetched back by its URN, so an ambiguous publish is answerable. */
      reconcilable: true,
      /**
       * UNVERIFIED as a published figure. LinkedIn documents `TOO_MANY_REQUESTS`
       * without a rate in the Posts API reference, so this is a conservative
       * budget rather than a quoted limit — deliberately low, because being
       * throttled by LinkedIn costs an account far more than a slow queue does.
       */
      rateLimit: { maxPosts: 100, windowMs: 24 * 60 * 60 * 1000 },
    },

    analytics: {
      /**
       * Both false, and honestly so.
       *
       * Post and page analytics live behind `r_organization_social` on separate
       * endpoints with their own shapes, and none of it is built. Declaring
       * `true` would have the ingestion sweep call a method that throws, which
       * reads as an outage rather than as a feature that does not exist.
       */
      post: false,
      account: false,
      metrics: [],
      deprecatedMetrics: [],
    },

    webhooks: { supported: false },
  });
}
