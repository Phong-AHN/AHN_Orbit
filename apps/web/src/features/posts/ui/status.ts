import type { PostStatus } from '@orbit/core';
import type { BadgeTone } from '@orbit/ui';

/**
 * How each status looks and reads.
 *
 * Typed as a total `Record<PostStatus, …>` rather than a partial one, so adding
 * a status to the state machine is a type error here until the UI has decided
 * how to show it — a new status silently rendering as grey "unknown" is exactly
 * the drift this prevents.
 */
export const STATUS_TONE: Record<PostStatus, BadgeTone> = {
  IDEA: 'neutral',
  DRAFT: 'neutral',
  INTERNAL_REVIEW: 'info',
  CLIENT_REVIEW: 'info',
  CHANGES_REQUESTED: 'warning',
  APPROVED: 'success',
  SCHEDULED: 'accent',
  PUBLISHING: 'accent',
  PUBLISHED: 'success',
  PARTIALLY_PUBLISHED: 'warning',
  FAILED: 'danger',
  CANCELED: 'neutral',
};

export const STATUS_LABEL: Record<PostStatus, string> = {
  IDEA: 'Idea',
  DRAFT: 'Draft',
  INTERNAL_REVIEW: 'Internal review',
  CLIENT_REVIEW: 'With client',
  CHANGES_REQUESTED: 'Changes requested',
  APPROVED: 'Approved',
  SCHEDULED: 'Scheduled',
  PUBLISHING: 'Publishing',
  PUBLISHED: 'Published',
  PARTIALLY_PUBLISHED: 'Partly published',
  FAILED: 'Failed',
  CANCELED: 'Canceled',
};
