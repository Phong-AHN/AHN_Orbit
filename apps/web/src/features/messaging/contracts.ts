import { z } from 'zod';

/**
 * Request bodies for private messages (**D-107**).
 *
 * The longest a platform takes is Messenger's 2,000 characters; Instagram's
 * byte limit is narrower and is checked against the descriptor in the service,
 * where the platform is known.
 */

export const messageReplySchema = z.object({
  text: z.string().trim().min(1).max(2_000),
});

export type MessageReplyInput = z.infer<typeof messageReplySchema>;

export const conversationAssignSchema = z.object({
  assignedToId: z.string().uuid().nullable(),
});

export type ConversationAssignInput = z.infer<typeof conversationAssignSchema>;

export const conversationHandledSchema = z.object({ handled: z.boolean() });
