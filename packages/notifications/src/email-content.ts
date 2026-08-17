import type { Email } from './mailer.js';

/**
 * Turning a notification row into a message somebody receives (SRS §18).
 *
 * **Plain text, deliberately.** An HTML email needs a template, a renderer, and
 * an inliner to survive Outlook — and the thing being said here is two
 * sentences and a link. Plain text renders identically everywhere, cannot leak
 * a tracking pixel, and reads correctly in a notification preview on a phone,
 * which is where most of these are read.
 *
 * **The email restates rather than links blindly.** Somebody reading a subject
 * line at 7am should know whether it needs them before they open anything, so
 * the title carries the fact and the body carries the action.
 */

export interface EmailNotification {
  to: string;
  title: string;
  body: string;
  /** Absolute, because a relative path in an inbox goes nowhere. */
  url: string;
  /** Named so the reader knows which of their agencies this is about. */
  organizationName: string;
}

export function renderEmail(input: EmailNotification): Email {
  return {
    to: input.to,
    // No prefix like "[Orbit]" — a subject line is scarce space on a phone, and
    // the sender name already says who it is from.
    subject: input.title,
    text: [
      input.body,
      '',
      input.url,
      '',
      '—',
      `${input.organizationName} · AHN Orbit`,
      'You are receiving this because you are a member of this organization.',
    ].join('\n'),
  };
}
