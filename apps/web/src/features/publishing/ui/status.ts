import type { BadgeTone } from '@orbit/ui';
import type { FailureAction } from '@orbit/core';

/**
 * How publishing state reads on screen (SRS §14, §29).
 *
 * Typed as total records so a new variant status or job state is a type error
 * here until someone decides how to show it — the same discipline as the post
 * status map.
 */

export type VariantPublishState =
  'DRAFT' | 'SCHEDULED' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED' | 'CANCELED' | 'NEEDS_REVIEW';

export const VARIANT_STATE_TONE: Record<VariantPublishState, BadgeTone> = {
  DRAFT: 'neutral',
  SCHEDULED: 'accent',
  PUBLISHING: 'accent',
  PUBLISHED: 'success',
  FAILED: 'danger',
  CANCELED: 'neutral',
  // Warning rather than danger: nothing is known to be wrong, and it may well
  // have published. It needs attention, not alarm.
  NEEDS_REVIEW: 'warning',
};

export const VARIANT_STATE_LABEL: Record<VariantPublishState, string> = {
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  PUBLISHING: 'Publishing',
  PUBLISHED: 'Published',
  FAILED: 'Failed',
  CANCELED: 'Canceled',
  NEEDS_REVIEW: 'Needs checking',
};

export type JobState =
  'PENDING' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'DEAD_LETTER';

export const JOB_STATE_TONE: Record<JobState, BadgeTone> = {
  PENDING: 'neutral',
  QUEUED: 'neutral',
  RUNNING: 'accent',
  SUCCEEDED: 'success',
  FAILED: 'danger',
  CANCELED: 'neutral',
  DEAD_LETTER: 'warning',
};

export const JOB_STATE_LABEL: Record<JobState, string> = {
  PENDING: 'Waiting',
  QUEUED: 'Queued',
  RUNNING: 'Running',
  SUCCEEDED: 'Succeeded',
  FAILED: 'Failed',
  CANCELED: 'Canceled',
  DEAD_LETTER: 'Needs checking',
};

export type AttemptState = 'IN_FLIGHT' | 'SUCCEEDED' | 'FAILED' | 'RECONCILED' | 'INCONCLUSIVE';

export const ATTEMPT_STATE_LABEL: Record<AttemptState, string> = {
  IN_FLIGHT: 'In progress',
  SUCCEEDED: 'Published',
  FAILED: 'Failed',
  // The distinction the ledger keeps: it published, we found out afterwards.
  RECONCILED: 'Published (found by checking)',
  INCONCLUSIVE: 'Outcome unknown',
};

export const ATTEMPT_STATE_TONE: Record<AttemptState, BadgeTone> = {
  IN_FLIGHT: 'accent',
  SUCCEEDED: 'success',
  FAILED: 'danger',
  RECONCILED: 'success',
  INCONCLUSIVE: 'warning',
};

/** The button an operator should see for a given recommended action. */
export const ACTION_LABEL: Record<FailureAction, string> = {
  RECONNECT_ACCOUNT: 'Reconnect the account',
  EDIT_CONTENT: 'Edit the post',
  FIX_MEDIA: 'Replace the file',
  RETRY: 'Try again',
  WAIT: 'Nothing to do — we will retry',
  REVIEW: 'Check the account',
  CONTACT_SUPPORT: 'Contact support',
};
