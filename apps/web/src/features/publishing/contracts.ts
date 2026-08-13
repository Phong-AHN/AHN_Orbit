import { z } from 'zod';

/**
 * Publishing log and resolution schemas (T1.14).
 *
 * As elsewhere, what is absent is the point. Nothing here lets a client write a
 * status, an attempt, a claim token or a publishing timestamp — those belong to
 * the engine. The one human write is `resolve`, and it is narrow, reasoned and
 * audited.
 */

/** Fields the engine owns. Supplying one is a logged 400. */
export const PROTECTED_PUBLISHING_FIELDS = [
  'status',
  'state',
  'claimToken',
  'claimedAt',
  'publishedAt',
  'attemptCount',
  'contentHash',
  'idempotencyKey',
] as const;

export const PUBLISHING_JOB_STATES = [
  'PENDING',
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
  'DEAD_LETTER',
] as const;

/** `"true"`/`"false"` from a query string, absent meaning unset. */
const booleanFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'));

export const publishingLogQuerySchema = z.object({
  state: z.enum(PUBLISHING_JOB_STATES).optional(),
  workspaceId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
  socialAccountId: z.string().uuid().optional(),
  needsReviewOnly: booleanFlag,
  failedOnly: booleanFlag,
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  /** The id of the last row of the previous page. */
  cursor: z.string().uuid().optional(),
});

/**
 * Recording what happened to a parked publish.
 *
 * `reason` is mandatory for every resolution, not just the risky one: all three
 * are a person overriding a machine that could not establish the truth, and in
 * six months someone will need to know how they knew.
 */
export const resolveParkedSchema = z
  .object({
    resolution: z.enum(['PUBLISHED', 'NOT_PUBLISHED', 'ABANDON']),
    reason: z.string().trim().min(1).max(1000),
    /** Only meaningful for `PUBLISHED`, where the person found the post. */
    externalPostId: z.string().trim().max(255).optional(),
    externalPermalink: z.string().trim().url().max(2048).optional(),
  })
  .refine((value) => value.resolution === 'PUBLISHED' || !value.externalPostId, {
    message: 'An external post id only applies when confirming it published',
    path: ['externalPostId'],
  })
  .refine((value) => value.resolution !== 'PUBLISHED' || Boolean(value.externalPostId?.trim()), {
    // A DB check constraint requires it too: a variant marked published with
    // nothing to point at is an unverifiable claim.
    message: "Paste the post's id or link from the platform",
    path: ['externalPostId'],
  });

export type PublishingLogQuery = z.infer<typeof publishingLogQuerySchema>;
export type ResolveParkedBody = z.infer<typeof resolveParkedSchema>;
