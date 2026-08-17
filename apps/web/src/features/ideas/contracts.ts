import { z } from 'zod';
import { CONTENT_IDEA_STATES, PLATFORMS } from '@orbit/core';

/**
 * Content ideas (SRS §25, Phase 4 P2).
 *
 * The thing an agency writes on a whiteboard: a topic, maybe a hook, maybe a
 * date it should land. Deliberately thinner than a post — an idea that demanded
 * a platform, a caption and a schedule would be a draft, and the product
 * already has drafts.
 *
 * As everywhere else, the client sends none of: `organizationId`,
 * `generatedById`, `state` on creation, or `generationId`. Those are the
 * server's.
 */

export const IDEA_STATES = CONTENT_IDEA_STATES;

export const createIdeaSchema = z.object({
  workspaceId: z.string().uuid(),
  brandId: z.string().uuid(),
  topic: z.string().trim().min(3).max(300),
  hook: z.string().trim().max(500).optional(),
  platform: z.enum(PLATFORMS).optional(),
  format: z.string().trim().max(80).optional(),
  caption: z.string().trim().max(5_000).optional(),
  cta: z.string().trim().max(300).optional(),
  /** A date rather than an instant: an idea is planned for a day, not 14:32. */
  plannedFor: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const updateIdeaSchema = z.object({
  topic: z.string().trim().min(3).max(300).optional(),
  hook: z.string().trim().max(500).optional(),
  platform: z.enum(PLATFORMS).nullable().optional(),
  format: z.string().trim().max(80).optional(),
  caption: z.string().trim().max(5_000).optional(),
  cta: z.string().trim().max(300).optional(),
  plannedFor: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  /**
   * `CONVERTED` is absent on purpose. An idea becomes converted by *being*
   * converted — the endpoint that creates the post sets it — so a client that
   * could set it directly could claim a post exists that does not.
   */
  state: z.enum(['SUGGESTED', 'ACCEPTED', 'DISMISSED']).optional(),
});

export type CreateIdeaInput = z.infer<typeof createIdeaSchema>;
export type UpdateIdeaInput = z.infer<typeof updateIdeaSchema>;
