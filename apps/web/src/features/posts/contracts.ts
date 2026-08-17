import { z } from 'zod';
import { POST_STATUSES } from '@orbit/core';

/**
 * Post request schemas (T1.9).
 *
 * What is absent matters as much as what is present. There is no `status`, no
 * `createdById`, no `organizationId`, no `publishedAt`, no `externalPostId`.
 * Status moves only through `/transition`, authorship comes from the session,
 * and publishing fields are written by the worker alone.
 *
 * `PROTECTED_POST_FIELDS` makes an attempt to supply one a logged 400 rather
 * than a silent strip, so a probe is visible.
 */

export const PROTECTED_POST_FIELDS = [
  'status',
  'createdById',
  'publishedAt',
  'contentHash',
  'externalPostId',
  'externalPermalink',
  'claimToken',
  'claimedAt',
  'lastError',
] as const;

const body = z.string().max(64_000);
const hashtags = z.array(z.string().trim().min(1).max(140)).max(100);
const mentions = z.array(z.string().trim().min(1).max(140)).max(100);
const linkUrl = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((v) => /^https?:\/\//i.test(v), { message: 'Only http and https links are allowed' });

/**
 * Per-platform settings for one variant.
 *
 * Deliberately a small, closed set of keys rather than an open record: this is
 * client-supplied JSON heading for a `Json` column, and "whatever the browser
 * sends" would be a place to park arbitrary data inside a tenant's row. The
 * adapter that reads these keys validates their *meaning* — TikTok checks the
 * privacy level against what the creator currently allows — while this checks
 * only their shape.
 *
 * TikTok is the only platform with entries today. A second one adds its keys
 * here, and adapters ignore keys they do not recognise.
 */
const platformOptions = z
  .object({
    postMode: z.enum(['DIRECT_POST', 'MEDIA_UPLOAD']).optional(),
    privacyLevel: z
      .enum(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'])
      .optional(),
    disableComment: z.boolean().optional(),
    disableDuet: z.boolean().optional(),
    disableStitch: z.boolean().optional(),
  })
  .strict();

/** Media, referenced by id. The asset itself is re-verified server-side. */
const mediaRefs = z
  .array(
    z.object({
      mediaAssetId: z.string().uuid(),
      altText: z.string().trim().max(1000).optional(),
    }),
  )
  .max(20);

export const createPostSchema = z.object({
  workspaceId: z.string().uuid(),
  brandId: z.string().uuid(),
  title: z.string().trim().max(200).optional(),
  body: body.default(''),
  linkUrl: linkUrl.optional(),
  hashtags: hashtags.default([]),
  mentions: mentions.default([]),
  media: mediaRefs.default([]),
  /** Accounts to publish to. Each becomes a PostVariant. */
  socialAccountIds: z.array(z.string().uuid()).max(50).default([]),
  assignedToId: z.string().uuid().nullish(),
});

export const updatePostSchema = z
  .object({
    title: z.string().trim().max(200).nullish(),
    body: body.optional(),
    linkUrl: linkUrl.nullish(),
    hashtags: hashtags.optional(),
    mentions: mentions.optional(),
    media: mediaRefs.optional(),
    socialAccountIds: z.array(z.string().uuid()).max(50).optional(),
    assignedToId: z.string().uuid().nullish(),
    approvalRequired: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Provide at least one field to update',
  });

/**
 * Autosave.
 *
 * Deliberately narrow: autosave touches the master copy only. Changing which
 * accounts a post targets is a deliberate act, not something a keystroke timer
 * should do.
 */
export const autosavePostSchema = z.object({
  title: z.string().trim().max(200).nullish(),
  body: body.optional(),
  linkUrl: linkUrl.nullish(),
  hashtags: hashtags.optional(),
  /** Version the client last saw, for conflict detection. */
  updatedAt: z.string().datetime().optional(),
});

/** Per-account override. Absent fields inherit from the master post. */
export const updateVariantSchema = z
  .object({
    body: body.nullish(),
    linkUrl: linkUrl.nullish(),
    hashtags: hashtags.nullish(),
    mentions: mentions.nullish(),
    firstComment: z.string().trim().max(2000).nullish(),
    media: mediaRefs.nullish(),
    platformOptions: platformOptions.nullish(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Provide at least one field to update',
  });

export const transitionSchema = z.object({
  to: z.enum(POST_STATUSES),
  comment: z.string().trim().max(2000).optional(),
});

export const assignPostSchema = z.object({
  assignedToId: z.string().uuid().nullable(),
});

export type CreatePostInput = z.infer<typeof createPostSchema>;
export type UpdatePostInput = z.infer<typeof updatePostSchema>;
export type UpdateVariantInput = z.infer<typeof updateVariantSchema>;
