import { z } from 'zod';
import { ASSISTANT_MODES, KNOWLEDGE_ENTRY_KINDS } from '@orbit/core';

/**
 * The AI assistant's settings and knowledge, as a browser may send them
 * (**D-108**).
 *
 * Nothing here names an organization, a workspace or a brand: the brand comes
 * from the URL and is resolved through the scoped client, and everything else
 * is derived on the server. The lengths are caps on what reaches a prompt.
 */

/** One entry's content. Long enough for a policy page, short enough for a prompt. */
export const MAX_ENTRY_CHARS = 10_000;

/** Entries per brand. The prompt's own budget is the real limit; this keeps the list usable. */
export const MAX_ENTRIES_PER_BRAND = 200;

export const knowledgeEntryInputSchema = z.object({
  kind: z.enum(KNOWLEDGE_ENTRY_KINDS),
  title: z.string().trim().min(1).max(200),
  question: z.string().trim().max(500).optional(),
  content: z.string().trim().min(1).max(MAX_ENTRY_CHARS),
  usableByAssistant: z.boolean().optional(),
});

export type KnowledgeEntryInput = z.infer<typeof knowledgeEntryInputSchema>;

export const knowledgeEntryUpdateSchema = knowledgeEntryInputSchema.partial();

export type KnowledgeEntryUpdate = z.infer<typeof knowledgeEntryUpdateSchema>;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

export const staffedPeriodSchema = z
  .object({ day: z.number().int().min(0).max(6), start: time, end: time })
  .refine((period) => period.start < period.end, {
    message: 'A period must end after it starts',
  });

export const assistantSettingsSchema = z.object({
  mode: z.enum(ASSISTANT_MODES),
  staffedHours: z.array(staffedPeriodSchema).max(21),
  graceMinutes: z.number().int().min(0).max(240),
  holdingMessage: z.string().trim().max(500).optional(),
  maxRepliesPerConversation: z.number().int().min(1).max(10),
  escalationTerms: z.array(z.string().trim().min(1).max(80)).max(50),
});

export type AssistantSettingsInput = z.infer<typeof assistantSettingsSchema>;

export const assistantTestSchema = z.object({
  text: z.string().trim().min(1).max(1_000),
});

export const decisionRatingSchema = z.object({ rating: z.boolean() });

export const conversationAssistantSchema = z.object({ paused: z.boolean() });
