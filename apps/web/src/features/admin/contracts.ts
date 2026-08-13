import { z } from 'zod';

/**
 * Request shapes for the admin surface (docs/API.md §2.13).
 *
 * Every mutating admin request carries a `reason` and nothing else. There is no
 * field here through which an administrator could name a different tenant, a
 * different job or a different outcome — the subject comes from the path, and
 * what happens to it is fixed by the endpoint.
 */

export const adminActionSchema = z.object({
  /**
   * Why. Mandatory, and validated again server-side by `assertReason` before
   * anything is written, so the length rule lives in one place rather than
   * being a zod constraint that a second caller could skip.
   */
  reason: z.string().trim().min(8).max(1_000),
});

export type AdminActionInput = z.infer<typeof adminActionSchema>;

/**
 * Fields an admin request may never carry.
 *
 * `organizationId` is on the global blocklist already; the rest are here
 * because this is the one surface where an actor legitimately operates across
 * tenants, which makes "the request told me which tenant" the exact mistake to
 * make impossible.
 */
export const PROTECTED_ADMIN_FIELDS = [
  'queue',
  'payload',
  'jobId',
  'actorType',
  'isPlatformAdmin',
] as const;
