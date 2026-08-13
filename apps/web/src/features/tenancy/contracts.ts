import { z } from 'zod';
import { ORGANIZATION_ROLES, WORKSPACE_ROLES } from '@orbit/core';

/**
 * Request/response schemas for T1.4 (docs/API.md §2.2, §2.3).
 *
 * Slugs are absent from every create schema on purpose: they are derived
 * server-side from the name, because a caller-chosen slug is a chance to
 * squat on or impersonate another tenant's URL.
 */

const name = z.string().trim().min(2, 'Name must be at least 2 characters').max(120);
const optionalUrl = z
  .string()
  .trim()
  .url()
  .max(2048)
  .optional()
  .or(z.literal('').transform(() => undefined));

/** Guards against a typo silently scheduling a client's content in the wrong zone. */
export const timezone = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Must be a valid IANA time zone, for example Europe/London' },
  );

export const createOrganizationSchema = z.object({
  name,
  timezone: timezone.default('UTC'),
});

export const updateOrganizationSchema = z
  .object({ name: name.optional(), timezone: timezone.optional(), logoUrl: optionalUrl })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Provide at least one field to update',
  });

export const createWorkspaceSchema = z.object({
  name,
  /** Required, not defaulted: scheduling correctness depends on it (SRS §36). */
  timezone,
  clientCompanyName: z.string().trim().max(160).optional(),
});

export const updateWorkspaceSchema = z
  .object({
    name: name.optional(),
    timezone: timezone.optional(),
    clientCompanyName: z.string().trim().max(160).nullish(),
    clientUploadsEnabled: z.boolean().optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Provide at least one field to update',
  });

export const createBrandSchema = z.object({
  name,
  website: optionalUrl,
  primaryColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex colour such as #14705F')
    .optional(),
});

export const updateBrandSchema = z
  .object({
    name: name.optional(),
    website: optionalUrl,
    primaryColor: z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullish(),
    logoUrl: optionalUrl,
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Provide at least one field to update',
  });

export const createInvitationSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(ORGANIZATION_ROLES),
  /** Workspaces the invitee is granted on acceptance. Required for CLIENT. */
  workspaceIds: z.array(z.string().uuid()).max(50).default([]),
});

export const acceptInvitationSchema = z.object({
  token: z.string().min(20).max(200),
});

export const addWorkspaceMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(WORKSPACE_ROLES),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
export type CreateBrandInput = z.infer<typeof createBrandSchema>;
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
