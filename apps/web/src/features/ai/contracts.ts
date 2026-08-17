import { z } from 'zod';
import { PLATFORMS } from '@orbit/core';

/**
 * What a client may ask for (T4.4, SRS §24).
 *
 * Note what is absent: **brand context**. The body carries a `brandId` and an
 * intent, and the server loads the brand's material itself. A request that
 * could supply brand context could supply *any* brand's context, or invent one
 * — and grounding would stop meaning anything.
 *
 * Also absent: the model id, the temperature, and the prompt. Those are the
 * product's, not the caller's.
 */

const brandId = z.string().uuid();
const platform = z.enum(PLATFORMS).optional();

/** Long enough to describe a campaign; short enough that a prompt stays bounded. */
const brief = z.string().trim().min(3).max(2_000);

export const captionRequestSchema = z.object({
  brandId,
  intent: brief,
  platform,
  maxLength: z.number().int().positive().max(50_000).optional(),
});

export const rewriteRequestSchema = z.object({
  brandId,
  text: brief,
  mode: z.enum(['shorten', 'expand', 'rephrase', 'tone']),
  tone: z.string().trim().max(200).optional(),
  platform,
  maxLength: z.number().int().positive().max(50_000).optional(),
});

export const hashtagRequestSchema = z.object({
  brandId,
  text: brief,
  platform,
  /** A cap, because each one is a token and thirty hashtags help nobody. */
  count: z.number().int().min(1).max(30).default(8),
});

/**
 * Repurposing existing content for another platform (Phase 4 P2).
 *
 * `targetPlatform` is required and `sourcePlatform` is not: content is often
 * adapted from something never published anywhere. Neither the length cap nor
 * whether the target renders links is accepted from the client — both come from
 * the target's own capability descriptor, which is the only thing that actually
 * knows.
 */
export const adaptRequestSchema = z.object({
  brandId,
  text: brief,
  targetPlatform: z.enum(PLATFORMS),
  sourcePlatform: z.enum(PLATFORMS).optional(),
});

export type AdaptRequest = z.infer<typeof adaptRequestSchema>;
export type CaptionRequest = z.infer<typeof captionRequestSchema>;
export type RewriteRequest = z.infer<typeof rewriteRequestSchema>;
export type HashtagRequest = z.infer<typeof hashtagRequestSchema>;
