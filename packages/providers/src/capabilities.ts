import { z } from 'zod';
import { PLATFORMS } from '@orbit/core';

/**
 * The platform capability descriptor (SRS §7, §9).
 *
 * This is the **single source of truth** for everything platform-specific.
 * The composer, the server-side validator, the publishing worker and the UI
 * all read the same descriptor, so a platform rule is stated once and cannot
 * drift between where it is enforced and where it is explained.
 *
 * The rule this file exists to enforce: **no `if (platform === 'FACEBOOK')`
 * anywhere outside packages/providers/facebook**. If the core needs to know
 * something about a platform, that something belongs here as data.
 *
 * A capability that is genuinely unavailable is declared `false` or omitted —
 * never faked (SRS §7: "do not pretend unsupported API functionality exists").
 */

// ── Media constraints ───────────────────────────────────────────────────────

export const mediaConstraintSchema = z.object({
  /** Accepted MIME types. Empty means this media kind is unsupported. */
  mimeTypes: z.array(z.string()).readonly(),
  maxBytes: z.number().int().positive(),
  minWidth: z.number().int().positive().optional(),
  minHeight: z.number().int().positive().optional(),
  maxWidth: z.number().int().positive().optional(),
  maxHeight: z.number().int().positive().optional(),
  /** Inclusive aspect-ratio bounds, expressed as width ÷ height. */
  minAspectRatio: z.number().positive().optional(),
  maxAspectRatio: z.number().positive().optional(),
  /** Video only. */
  minDurationMs: z.number().int().nonnegative().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  /**
   * Frames per second the platform will accept.
   *
   * Checked against the **peak** rate, not the average. A phone records
   * variable frame rate by default: the file is labelled 30fps, the average is
   * around 30, and the instantaneous rate spikes far past any ceiling — which
   * is what the platform's own checker sees. TikTok refuses those with
   * `frame_rate_check_failed`, and the owner is left certain their 30fps video
   * was rejected for being 30fps.
   */
  minFrameRate: z.number().positive().optional(),
  maxFrameRate: z.number().positive().optional(),
});

export type MediaConstraint = z.infer<typeof mediaConstraintSchema>;

// ── The descriptor ──────────────────────────────────────────────────────────

export const platformCapabilitiesSchema = z.object({
  platform: z.enum(PLATFORMS),
  /**
   * Account kind this descriptor applies to (a Facebook Page and an Instagram
   * Creator account differ). `null` means it applies to every account type.
   */
  accountType: z.string().nullable().default(null),

  /**
   * Graph/API version the descriptor was verified against, recorded on every
   * analytics snapshot so a metric change is traceable to a version bump
   * (docs/SOCIAL_PROVIDERS.md §3).
   */
  apiVersion: z.string(),
  /** Date the capabilities were last checked against provider documentation. */
  verifiedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),

  text: z.object({
    supported: z.boolean(),
    maxLength: z.number().int().positive(),
    /** Some platforms count a link or mention as a fixed number of characters. */
    linkCharacterCost: z.number().int().nonnegative().optional(),
    /** Whether a post may consist of media with no text at all. */
    allowsEmptyWithMedia: z.boolean().default(true),
  }),

  link: z.object({
    supported: z.boolean(),
    /** Maximum links permitted in the body. */
    maxCount: z.number().int().nonnegative().default(0),
  }),

  media: z.object({
    image: mediaConstraintSchema.nullable(),
    video: mediaConstraintSchema.nullable(),
    gif: mediaConstraintSchema.nullable(),
    /** Max attachments in one post. 0 means media is unsupported entirely. */
    maxAttachments: z.number().int().nonnegative(),
    /** Whether images and video may be mixed in one post. */
    allowsMixedKinds: z.boolean().default(false),
    /** Whether the platform renders multiple images as a native carousel. */
    carousel: z.boolean().default(false),
    /** Whether alt text can be supplied through the API. */
    altText: z.boolean().default(false),
    /** Whether media is *required* (Instagram feed posts, for example). */
    required: z.boolean().default(false),
  }),

  hashtags: z.object({
    supported: z.boolean(),
    maxCount: z.number().int().nonnegative().optional(),
  }),

  mentions: z.object({ supported: z.boolean() }),

  /** Posting a first comment alongside the post (common hashtag strategy). */
  firstComment: z.object({
    supported: z.boolean(),
    maxLength: z.number().int().positive().optional(),
  }),

  scheduling: z.object({
    /** Whether the *provider* can hold a scheduled post. Orbit schedules its
     *  own regardless (SRS §13); this is a fallback, not the mechanism. */
    providerSide: z.boolean(),
    minLeadMs: z.number().int().nonnegative().optional(),
    maxLeadMs: z.number().int().positive().optional(),
  }),

  lifecycle: z.object({
    /** Whether a published post can be edited through the API at all. */
    edit: z.boolean(),
    /**
     * True when the API only permits editing posts this app created. Facebook
     * is the motivating case; the composer must explain rather than fail
     * (docs/SOCIAL_PROVIDERS.md §2 note 7).
     */
    editOwnPostsOnly: z.boolean().default(false),
    delete: z.boolean(),
    /** Whether the published post's status can be read back. */
    readStatus: z.boolean().default(true),
  }),

  publishing: z.object({
    /**
     * Whether the API accepts a client-supplied idempotency key. When false,
     * the publishing engine must reconcile before retrying an ambiguous
     * outcome (docs/ARCHITECTURE.md §5.2 layer 4).
     */
    idempotencyKey: z.boolean(),
    /** Whether the provider can be queried to find a post we may have created. */
    reconcilable: z.boolean(),
    /** Rolling published-post cap, if the platform enforces one. */
    rateLimit: z
      .object({ maxPosts: z.number().int().positive(), windowMs: z.number().int().positive() })
      .nullable()
      .default(null),
  }),

  analytics: z.object({
    post: z.boolean(),
    account: z.boolean(),
    /** Metric names this platform actually serves, at `apiVersion`. */
    metrics: z.array(z.string()).readonly().default([]),
    /**
     * Metrics the provider has withdrawn. Requesting one is an error, not an
     * empty result, so they are listed to be surfaced as "not available"
     * rather than charted as zero (SRS §18).
     */
    deprecatedMetrics: z.array(z.string()).readonly().default([]),
  }),

  webhooks: z.object({ supported: z.boolean() }),
});

export type PlatformCapabilities = z.infer<typeof platformCapabilitiesSchema>;

/**
 * Parse and validate a descriptor. Called once per provider at registration,
 * so a malformed descriptor fails at boot rather than at publish time.
 */
export function defineCapabilities(input: unknown): PlatformCapabilities {
  const parsed = platformCapabilitiesSchema.parse(input);

  // Cross-field rules the schema alone cannot express.
  if (
    parsed.media.maxAttachments > 0 &&
    !parsed.media.image &&
    !parsed.media.video &&
    !parsed.media.gif
  ) {
    throw new Error(
      `${parsed.platform}: maxAttachments > 0 but no media kind is described — a post could never satisfy it.`,
    );
  }
  if (parsed.media.required && parsed.media.maxAttachments === 0) {
    throw new Error(`${parsed.platform}: media is required but maxAttachments is 0.`);
  }
  if (!parsed.text.supported && parsed.media.maxAttachments === 0) {
    throw new Error(`${parsed.platform}: neither text nor media is supported.`);
  }
  if (parsed.lifecycle.editOwnPostsOnly && !parsed.lifecycle.edit) {
    throw new Error(`${parsed.platform}: editOwnPostsOnly set while editing is unsupported.`);
  }

  const overlap = parsed.analytics.metrics.filter((m) =>
    parsed.analytics.deprecatedMetrics.includes(m),
  );
  if (overlap.length > 0) {
    throw new Error(
      `${parsed.platform}: metric(s) listed as both available and deprecated: ${overlap.join(', ')}`,
    );
  }

  return parsed;
}

/** Whether a metric can be requested at this API version. */
export function metricAvailability(
  capabilities: PlatformCapabilities,
  metric: string,
): 'AVAILABLE' | 'DEPRECATED' | 'UNSUPPORTED' {
  if (capabilities.analytics.deprecatedMetrics.includes(metric)) return 'DEPRECATED';
  if (capabilities.analytics.metrics.includes(metric)) return 'AVAILABLE';
  return 'UNSUPPORTED';
}
