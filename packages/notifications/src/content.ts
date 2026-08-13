import type { NotificationEvent } from './types.js';

/**
 * The words a person actually reads (SRS §22).
 *
 * Two rules hold throughout:
 *
 *  • **Say what to do, not just what happened.** The reader's next question is
 *    always "so what do I do?", and a notification that does not answer it is a
 *    notification they will learn to skim past.
 *  • **No counts, no live figures.** Everything here is true at the moment of
 *    writing and read hours later. "3 posts affected" ages badly; the page it
 *    links to shows the real number.
 *
 * Nothing here touches the database, so the copy is unit-testable and the same
 * sentence is produced whichever process raised the event.
 */

export interface NotificationContent {
  title: string;
  body: string;
}

export function notificationContent(event: NotificationEvent): NotificationContent {
  switch (event.type) {
    case 'social_account.needs_reconnect':
      return {
        title: `${event.accountName} needs reconnecting`,
        body:
          (event.reason ?? 'The connection to this account is no longer valid.') +
          ' Posts scheduled for it will not publish until someone reconnects it.',
      };

    case 'social_account.reconnected':
      return {
        title: `${event.accountName} is connected again`,
        body: 'Scheduled posts for this account will publish as normal.',
      };

    case 'post.approval_requested':
      return {
        title:
          event.stage === 'CLIENT'
            ? `${event.postTitle} is with the client`
            : `${event.postTitle} needs your review`,
        body:
          event.stage === 'CLIENT'
            ? 'It is waiting on client approval before it can be scheduled.'
            : 'Review it and either approve it or ask for changes.',
      };

    case 'post.changes_requested':
      return {
        title: `Changes requested on ${event.postTitle}`,
        body: event.note
          ? `“${truncate(event.note, 160)}” — open the post to make the changes.`
          : 'Open the post to see what needs changing.',
      };

    case 'publishing.failed':
      return {
        title: `${event.postTitle} did not publish to ${event.accountName}`,
        body: `${event.summary} Open the publishing log to see what to do next.`,
      };

    case 'publishing.needs_review':
      return {
        title: `Check whether ${event.postTitle} went out on ${event.accountName}`,
        // Deliberately not "it failed": we do not know, and saying so is the
        // whole point of parking it (decision D-027).
        body:
          'We could not confirm whether this published, so we stopped rather than risk posting ' +
          'it twice. Someone needs to look and record what they find.',
      };

    default: {
      const exhaustive: never = event;
      throw new Error(`Unhandled notification event: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Keeps a quoted note to one readable line without cutting mid-word. */
function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
