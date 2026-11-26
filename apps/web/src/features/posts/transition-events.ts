import type { PostStatus } from '@orbit/core';
import type { NotificationType } from '@orbit/notifications';

/**
 * Which transitions are worth telling someone about (SRS §22).
 *
 * ## Why this returns a list
 *
 * It used to return one event, and `CLIENT_REVIEW` reused the internal one:
 * both gates read as "someone needs to look at this", and the processor told
 * them apart by the post's status to pick the wording.
 *
 * **The wording was the only thing that differed, and it was not the only thing
 * that should have.** `post.approval_requested` fans out on
 * `post:approve_internal`, which no client holds — so opening the client's gate
 * notified the agency that it was "with the client" and told the client
 * nothing. One event cannot address two different sets of people.
 *
 * So the client's gate now raises two: the agency's status update, and the
 * client's actual prompt. Same transition, two audiences, two events.
 *
 * ## Why it takes where the post came from
 *
 * Coming off the schedule is news only when the post was on it (D-129).
 * Canceling a draft nobody scheduled tells nobody anything; canceling a post
 * due out on Friday tells the people expecting it that it is not coming.
 */
export function transitionEvents(from: PostStatus, to: PostStatus): readonly NotificationType[] {
  if (from === 'SCHEDULED' && to === 'CANCELED') return ['post.canceled'];
  if (from === 'SCHEDULED' && to === 'DRAFT') return ['post.unscheduled'];

  switch (to) {
    case 'INTERNAL_REVIEW':
      return ['post.approval_requested'];

    case 'CLIENT_REVIEW':
      return ['post.approval_requested', 'post.client_review_requested'];

    case 'CHANGES_REQUESTED':
      return ['post.changes_requested'];

    // Nothing fired here before, so an approval — including the client's, which
    // is the last gate — was something the agency had to notice for itself.
    case 'APPROVED':
      return ['post.approved'];

    default:
      return [];
  }
}
