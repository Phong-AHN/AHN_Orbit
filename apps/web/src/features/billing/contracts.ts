import { z } from 'zod';
import { REQUESTABLE_PLAN_IDS } from './plans';

/**
 * Request shapes for changing plan (D-116).
 *
 * Neither carries an organization, a price or a set of limits. The organization
 * comes from the URL and the caller's membership; the limits come from the plan
 * catalogue when an administrator approves. So a request can name *which* plan
 * and nothing about what that plan grants.
 */

export const planRequestSchema = z.object({
  /** Only a plan someone may ask for: the trial is where everybody starts. */
  plan: z.enum(REQUESTABLE_PLAN_IDS),
  /** For AHN: who to contact, how they would like to pay. */
  note: z.string().trim().max(500).optional(),
});

export type PlanRequestInput = z.infer<typeof planRequestSchema>;

/**
 * An administrator's answer. The plan applied is the one the organization
 * asked for, read from the stored request; nothing here can name another.
 */
export const planDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'DECLINE']),
  /**
   * Mandatory, and checked again by `assertReason` before anything is written.
   * It lands in the organization's own audit trail.
   */
  reason: z.string().trim().min(8).max(1_000),
});

export type PlanDecisionInput = z.infer<typeof planDecisionSchema>;
