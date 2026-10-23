/**
 * The decisions behind how the message inbox reads (**D-107**) — pure, so they
 * can be tested without a browser.
 *
 * Nobody has looked at these screens rendered. What is most likely to be
 * wrong is therefore kept here: what the reply deadline says, what a preview
 * line shows for a message that is only a photo or was unsent, and what a
 * conversation is called when the platform gave us no name.
 */

export interface WindowView {
  state: 'OPEN' | 'HUMAN_AGENT' | 'CLOSED';
  /** ISO string, as it crosses from server to client. */
  closesAt: string | null;
}

export interface WindowLabel {
  /** One short line for the composer and the list. */
  text: string;
  tone: 'neutral' | 'warning' | 'danger';
}

const HOUR_MS = 60 * 60 * 1_000;

/**
 * How long is left to answer, in words a person acts on.
 *
 * Warning under three hours, because that is the point at which "later" stops
 * being safe. The human-agent window is said by name, so nobody wonders why a
 * conversation from four days ago can still be answered.
 */
export function windowLabel(window: WindowView, now: Date): WindowLabel {
  if (window.state === 'CLOSED' || !window.closesAt) {
    return { text: 'Can’t reply until they message again', tone: 'danger' };
  }

  const remainingMs = new Date(window.closesAt).getTime() - now.getTime();
  const remaining = describeRemaining(remainingMs);

  if (window.state === 'HUMAN_AGENT') {
    return { text: `Reply as a person within ${remaining}`, tone: 'warning' };
  }

  return {
    text: `Reply within ${remaining}`,
    tone: remainingMs < 3 * HOUR_MS ? 'warning' : 'neutral',
  };
}

/** "45 min", "5 h", "3 days" — rounded down, so it never promises more time than is left. */
export function describeRemaining(ms: number): string {
  if (ms <= 0) return 'moments';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

export interface PreviewMessage {
  direction: 'INBOUND' | 'OUTBOUND';
  text: string | null;
  attachments: unknown;
  deletedAt: string | Date | null;
}

/**
 * The one line under a conversation in the list.
 *
 * The brand's own last message is prefixed "You:", which is how both
 * platforms' inboxes tell "they are waiting on us" from "we are waiting on
 * them" at a glance.
 */
export function previewLine(message: PreviewMessage | null): string {
  if (!message) return 'No messages yet';
  const prefix = message.direction === 'OUTBOUND' ? 'You: ' : '';

  if (message.deletedAt) return `${prefix}Message unsent`;

  const text = message.text?.trim();
  if (text) return `${prefix}${text.length > 90 ? `${text.slice(0, 89)}…` : text}`;

  return `${prefix}${attachmentWord(message.attachments)}`;
}

/** What to call a message that is only an attachment. */
export function attachmentWord(attachments: unknown): string {
  const first = Array.isArray(attachments)
    ? (attachments[0] as { type?: unknown } | undefined)
    : undefined;
  switch (first?.type) {
    case 'image':
      return 'Sent a photo';
    case 'video':
    case 'reel':
    case 'ig_reel':
      return 'Sent a video';
    case 'audio':
      return 'Sent a voice message';
    case 'story_mention':
    case 'story':
    case 'ig_story':
      return 'Mentioned you in a story';
    case 'share':
    case 'ig_post':
      return 'Shared a post';
    default:
      return first ? 'Sent an attachment' : 'Sent a message';
  }
}

/**
 * The name a conversation goes by.
 *
 * The platform's display name, then the username, then — when a webhook
 * brought only an id and the profile lookup was refused — a neutral label
 * rather than the id, which is meaningless to a person and is not shown.
 */
export function participantLabel(conversation: {
  participantName: string | null;
  participantUsername: string | null;
}): string {
  return (
    conversation.participantName?.trim() ||
    (conversation.participantUsername ? `@${conversation.participantUsername}` : '') ||
    'Instagram or Facebook user'
  );
}

/** Attachments as stored: `[{ type, url }]`, defensively read. */
export function attachmentsOf(value: unknown): Array<{ type: string; url: string | null }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is { type: string; url?: unknown } =>
        Boolean(item) && typeof (item as { type?: unknown }).type === 'string',
    )
    .map((item) => ({ type: item.type, url: typeof item.url === 'string' ? item.url : null }));
}
