import { z } from 'zod';

/**
 * Request shapes for the portal (docs/API.md §2.12).
 *
 * Narrow on purpose. The portal accepts two verbs — a decision and a comment —
 * and each takes the minimum that verb needs. Everything else about the request
 * is derived: the post from the path, the workspace and tenant from the post,
 * the author from the session, the comment's visibility from the role.
 */

export const portalDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'CHANGES_REQUESTED']),
  /** Required when asking for changes: "no, but" without the "but" is not usable. */
  comment: z.string().trim().min(1).max(5_000).optional(),
});

export const portalCommentSchema = z.object({
  body: z.string().trim().min(1).max(5_000),
  /** A reply must join a thread the client can already see; checked server-side. */
  parentId: z.string().uuid().optional(),
});

export type PortalDecisionInput = z.infer<typeof portalDecisionSchema>;
export type PortalCommentInput = z.infer<typeof portalCommentSchema>;

/**
 * Fields a portal request may never carry.
 *
 * `visibility` is the one that matters: a client sending
 * `visibility: 'INTERNAL'` would be trying to write into a thread they cannot
 * read back. `createComment` already forces a Client's comment to
 * `CLIENT_VISIBLE` whatever they send — this makes the attempt a **logged 400**
 * rather than a silent correction, which is the difference between noticing a
 * probe and not.
 *
 * `onBehalfOf` and `reason` belong to the internal relay path (docs/RBAC.md
 * note 5). A client recording a decision "on behalf of" themselves is
 * meaningless; on behalf of anyone else is the thing that must not be possible.
 */
export const PROTECTED_PORTAL_FIELDS = [
  'visibility',
  'onBehalfOf',
  'reason',
  'stage',
  'state',
  'status',
  'postId',
  'workspaceId',
  'brandId',
  'authorId',
  'approvalId',
] as const;
