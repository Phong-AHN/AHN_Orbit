import { z } from 'zod';
import {
  APPROVAL_DECISIONS,
  APPROVAL_STAGES,
  APPROVAL_STATES,
  COMMENT_VISIBILITIES,
} from '@orbit/core';

/**
 * Approval and comment request schemas (T1.10).
 *
 * As with posts, what is missing is the point. There is no `state`, no `stage`,
 * no `round`, no `decidedById`, no `postId` on a decision — the stage comes from
 * the approval row, the round from the post's history, the decider from the
 * session, and the resulting status from the state machine.
 */

/** Fields the server derives on an approval. Supplying one is a logged 400. */
export const PROTECTED_APPROVAL_FIELDS = [
  'state',
  'stage',
  'round',
  'requestedById',
  'requestedAt',
  'decidedById',
  'decidedAt',
  'postId',
] as const;

/** Fields the server derives on a comment. */
export const PROTECTED_COMMENT_FIELDS = [
  'authorId',
  'postId',
  'resolvedAt',
  'resolvedById',
] as const;

export const decideApprovalSchema = z
  .object({
    decision: z.enum(APPROVAL_DECISIONS),
    comment: z.string().trim().max(4000).optional(),
    onBehalfOf: z.boolean().default(false),
    /** Mandatory when `onBehalfOf` is set — checked again in the service. */
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .refine((v) => !v.onBehalfOf || Boolean(v.reason), {
    message: 'A reason is required when recording a decision on someone else’s behalf',
    path: ['reason'],
  })
  .refine((v) => v.decision !== 'CHANGES_REQUESTED' || Boolean(v.comment), {
    // Asking for changes without saying what to change is not a review.
    message: 'Say what needs to change',
    path: ['comment'],
  });

export const approvalQueueQuerySchema = z.object({
  stage: z.enum(APPROVAL_STAGES).optional(),
  state: z.enum(APPROVAL_STATES).optional(),
  workspaceId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
});

export const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
  visibility: z.enum(COMMENT_VISIBILITIES).optional(),
  postVariantId: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
  mentionedUserIds: z.array(z.string().uuid()).max(50).optional(),
});

export const updateCommentSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
});

export type DecideApprovalBody = z.infer<typeof decideApprovalSchema>;
export type CreateCommentBody = z.infer<typeof createCommentSchema>;
