import type { BadgeTone } from '@orbit/ui';
import { CLIENT_VISIBLE_STATUSES } from '@orbit/rbac';

/**
 * How a post's status reads to a client (SRS §21).
 *
 * A **translation**, not a second status model — the enum is unchanged and the
 * state machine is untouched. What changes is the vocabulary: `CLIENT_REVIEW`
 * is the agency's name for a queue, and to the person in it the useful sentence
 * is "waiting for your approval".
 *
 * Typed over `CLIENT_VISIBLE_STATUSES` rather than every `PostStatus`, so this
 * map cannot accidentally acquire a label for a status a client must never see
 * — `DRAFT` and `FAILED` have no entry because they can never arrive here.
 */
export type ClientVisibleStatus = (typeof CLIENT_VISIBLE_STATUSES)[number];

export const CLIENT_STATUS_LABEL: Record<ClientVisibleStatus, string> = {
  CLIENT_REVIEW: 'Waiting for your approval',
  CHANGES_REQUESTED: 'Changes requested',
  APPROVED: 'Approved',
  SCHEDULED: 'Scheduled',
  PUBLISHING: 'Publishing',
  PUBLISHED: 'Published',
  // Deliberately not "partly failed". The agency is dealing with the rest, and
  // a client reading a failure they cannot act on only generates a phone call.
  PARTIALLY_PUBLISHED: 'Published',
};

export const CLIENT_STATUS_TONE: Record<ClientVisibleStatus, BadgeTone> = {
  CLIENT_REVIEW: 'warning',
  CHANGES_REQUESTED: 'neutral',
  APPROVED: 'success',
  SCHEDULED: 'accent',
  PUBLISHING: 'accent',
  PUBLISHED: 'success',
  PARTIALLY_PUBLISHED: 'success',
};

export function isClientVisibleStatus(value: string): value is ClientVisibleStatus {
  return (CLIENT_VISIBLE_STATUSES as readonly string[]).includes(value);
}

/** Label for anything unexpected, rather than showing a raw enum to a client. */
export function clientStatusLabel(value: string): string {
  return isClientVisibleStatus(value) ? CLIENT_STATUS_LABEL[value] : 'In progress';
}

export function clientStatusTone(value: string): BadgeTone {
  return isClientVisibleStatus(value) ? CLIENT_STATUS_TONE[value] : 'neutral';
}
