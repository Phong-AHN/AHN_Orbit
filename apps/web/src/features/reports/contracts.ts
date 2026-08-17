import { z } from 'zod';

/**
 * What a client may ask for when generating a report (T3.5, SRS §19).
 *
 * Note what is absent: no `organizationId`, no `requestedById`, no `status`, no
 * `storageKey`, no `expiresAt`. Every one of those is decided by the server —
 * the tenant from the session, the requester from the session, the status by
 * the render pipeline, and the key and expiry by policy. A request body that
 * could name any of them would be a request body that could hand somebody
 * another tenant's report.
 */

export const REPORT_FORMATS = ['CSV'] as const;

/**
 * The window a report covers, as plain dates.
 *
 * Days rather than instants: a client report is "May 2026", not "the 720 hours
 * from 09:14 on the 1st". The service turns these into a range.
 */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((value) => !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime()), {
    message: 'Not a real date',
  });

export const createReportSchema = z
  .object({
    from: isoDate,
    to: isoDate,
    /** Optional: one client rather than the whole agency. */
    workspaceId: z.string().uuid().optional(),
    brandId: z.string().uuid().optional(),
    format: z.enum(REPORT_FORMATS).default('CSV'),
  })
  .refine((value) => value.from <= value.to, {
    message: 'The range starts after it ends',
    path: ['from'],
  });

export type CreateReportInput = z.infer<typeof createReportSchema>;

/**
 * The stored `parameters` shape.
 *
 * Re-parsed by the worker rather than trusted: the row is written by this
 * service today, but a renderer that assumed its input was well-formed would
 * be one migration away from a crash loop on an old row.
 */
export const reportParametersSchema = z.object({
  from: z.string(),
  to: z.string(),
  workspaceId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
});

export type ReportParameters = z.infer<typeof reportParametersSchema>;
