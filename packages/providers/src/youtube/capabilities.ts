import { defineCapabilities, type PlatformCapabilities } from '../capabilities.js';

/**
 * YouTube capability descriptor (SRS §7).
 *
 * The seventh platform, and the first where the product Orbit is publishing to
 * is a *video host* rather than a feed. Two consequences shape everything here:
 *
 *   • **Media is not optional and text is not a post.** There is no such thing
 *     as a YouTube post without a video, so `media.required` is true and the
 *     "text" fields are the video's title and description rather than a body.
 *   • **A legal declaration is mandatory.** YouTube requires the uploader to
 *     state whether the video is made for children, and that is an audience
 *     declaration with regulatory weight (COPPA). Orbit refuses to guess it —
 *     see `youtube/provider.ts`.
 *
 * A **Short** is not a separate API. It is an ordinary upload that YouTube
 * classifies as a Short when it is vertical and short enough, so nothing here
 * distinguishes one; declaring a "Shorts mode" would be inventing a control the
 * platform does not have.
 */

export const YOUTUBE_UPLOAD_HOST = 'https://www.googleapis.com';
export const YOUTUBE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const YOUTUBE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Verified: `youtube.upload` is what `videos.insert` needs; `youtube.readonly`
 * is what listing the signed-in channels needs.
 *
 * Deliberately *not* the broad `.../auth/youtube` scope, which also grants
 * deleting videos and editing playlists. Orbit does neither, and asking for
 * more than a product uses makes a consent screen frightening and a review
 * harder.
 */
export const YOUTUBE_PUBLISH_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
] as const;

/** Verified: statistics the Data API serves per video. */
export const YOUTUBE_VIDEO_METRICS = [
  'viewCount',
  'likeCount',
  'commentCount',
  'favoriteCount',
] as const;

/** Privacy states `status.privacyStatus` accepts. */
export const YOUTUBE_PRIVACY = ['public', 'unlisted', 'private'] as const;
export type YouTubePrivacy = (typeof YOUTUBE_PRIVACY)[number];

export function youtubeCapabilities(apiVersion: string): PlatformCapabilities {
  return defineCapabilities({
    platform: 'YOUTUBE',
    accountType: null,
    apiVersion,
    verifiedOn: '2026-08-18',

    text: {
      supported: true,
      /**
       * Verified: the **title** is capped at 100 characters, and it is the
       * field a person actually writes. The description allows 5,000, but a
       * post whose first line overflows the title is the failure that matters,
       * so the shorter limit is the one enforced and the composer counts
       * against it.
       *
       * The full body still becomes the description; only the first line
       * becomes the title. See `provider.ts`.
       */
      maxLength: 100,
      allowsEmptyWithMedia: true,
    },

    /**
     * A URL in a description is clickable, but there is no link *post* type —
     * a link is part of the description, never the content itself.
     */
    link: { supported: true, maxCount: 1 },

    media: {
      // There is no image post on YouTube. A thumbnail is a separate API.
      image: null,

      /**
       * Verified formats from YouTube's supported-format list. The byte
       * ceiling is 256 GB for a verified account, which is far beyond what
       * Orbit's own media pipeline stores — the storage layer's 512 MB ceiling
       * is the real constraint, and duplicating it here would be a second
       * number to keep in step.
       *
       * UNVERIFIED: no duration or frame-rate ceiling is enforced. YouTube
       * accepts 12 hours and effectively any frame rate, so a limit here would
       * only refuse what the platform would have taken.
       */
      video: {
        mimeTypes: ['video/mp4', 'video/quicktime'],
        maxBytes: 256 * 1024 * 1024 * 1024,
      },

      gif: null,
      /** One video is one upload. There is no multi-video post. */
      maxAttachments: 1,
      allowsMixedKinds: false,
      carousel: false,
      // A thumbnail is `thumbnails.set`, a separate call; alt text has no
      // equivalent at all.
      altText: false,
      /** **The whole point of the platform.** Text alone is not a YouTube post. */
      required: true,
    },

    /**
     * Hashtags in the description become links, and the first three appear
     * above the title. Verified: at most 15, and YouTube ignores *all* of them
     * past that rather than truncating — worth encoding, because the failure is
     * silent.
     */
    hashtags: { supported: true, maxCount: 15 },

    /** `@channel` mentions work in a description without any URN lookup. */
    mentions: { supported: true },

    /** A comment is a separate API and a separate permission. Not built. */
    firstComment: { supported: false },

    scheduling: {
      /**
       * YouTube *can* hold a private video and publish it at
       * `status.publishAt`. Orbit's queue is the scheduler (SRS §13), and using
       * both would create two sources of truth for when a video goes out.
       */
      providerSide: false,
    },

    lifecycle: {
      edit: false,
      editOwnPostsOnly: false,
      /**
       * `videos.delete` exists, but it needs the broad `.../auth/youtube`
       * scope. Declaring delete true would mean asking every connecting channel
       * for permission to delete any of its videos, to support a feature nobody
       * has asked for. False is the honest consequence of the narrower scope.
       */
      delete: false,
      readStatus: true,
    },

    publishing: {
      idempotencyKey: false,
      /** A video can be read back by its id, so an ambiguous upload is answerable. */
      reconcilable: true,
      /**
       * Verified: uploads bill to **their own daily bucket of 100 calls**,
       * separate from the 10,000-unit pool the rest of the API draws on.
       *
       * This changed in December 2025 — `videos.insert` used to cost 1,600
       * units, which capped a project at six uploads a day, and most guides
       * still say so. The figure here is the current one, and it is the reason
       * an agency can schedule YouTube at all.
       */
      rateLimit: { maxPosts: 100, windowMs: 24 * 60 * 60 * 1000 },
    },

    analytics: {
      post: true,
      /**
       * Channel-level figures need the YouTube **Analytics** API — a different
       * API with its own scope and its own reporting model. Declaring it true
       * would have the sweep call a method that throws.
       */
      account: false,
      metrics: [...YOUTUBE_VIDEO_METRICS],
      deprecatedMetrics: [],
    },

    webhooks: { supported: false },
  });
}
