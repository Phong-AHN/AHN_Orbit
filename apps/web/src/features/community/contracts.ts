import { z } from 'zod';
import { SOCIAL_COMMENT_STATES } from '@orbit/core';

/**
 * What a caller may say about a comment (docs/API.md §2.15).
 *
 * The shape of these is most of the security story for this feature. Three
 * things a client is structurally unable to send:
 *
 * - **A reply addressed to an arbitrary platform id.** `commentId` is Orbit's
 *   own uuid, so the service resolves the platform id from a row it has already
 *   scoped to the tenant. A schema taking `externalId` would let somebody post
 *   a comment on any object on the platform their token can reach.
 * - **An author.** Who replied is the session principal. There is no field.
 * - **A state transition of its own invention.** `state` is the closed enum
 *   from `@orbit/core`, shared with the Postgres enum by a drift test.
 */

export const commentQuerySchema = z.object({
  workspaceId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
  socialAccountId: z.string().uuid().optional(),
  state: z.enum(SOCIAL_COMMENT_STATES).optional(),
  /** Only the public's comments by default; our own replies are context. */
  includeOurs: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  /** `postedAt` of the last row seen, for keyset paging. */
  before: z.coerce.date().optional(),
});

export type CommentQuery = z.infer<typeof commentQuerySchema>;

export const replySchema = z.object({
  /**
   * Orbit's id for the comment being answered, never the platform's.
   *
   * Capped at the same length the platforms accept for a comment, and trimmed
   * before the length is measured so trailing whitespace cannot be used to
   * push a message past a provider's own limit.
   */
  message: z.string().trim().min(1).max(8000),
});

export type ReplyInput = z.infer<typeof replySchema>;

export const assignSchema = z.object({
  /** Null clears the assignment, which is how somebody hands it back. */
  assignedToId: z.string().uuid().nullable(),
});

export type AssignInput = z.infer<typeof assignSchema>;
