/**
 * When a brand may still answer a private message (**D-107**).
 *
 * The platforms that allow replying to a private message through an API do it
 * only in answer to the person, and only for a while: Messenger and Instagram
 * open a standard window when the person writes, and an app approved for the
 * Human Agent tag may extend it for a reply typed by a person. After that the
 * brand cannot write first, and the platform refuses the call.
 *
 * Decided here, from numbers the adapter supplies, rather than discovered by
 * sending: a refusal after somebody has typed a careful answer is the worst
 * moment to learn the window closed, and the composer can show the deadline
 * before anyone starts.
 */

export type ReplyWindowState =
  /** Inside the standard window. A plain reply goes out. */
  | 'OPEN'
  /** Past the standard window, inside the human-agent one. The reply is tagged. */
  | 'HUMAN_AGENT'
  /** Nothing may be sent until the person writes again. */
  | 'CLOSED';

export interface ReplyWindow {
  state: ReplyWindowState;
  /** When the current window ends. Null when closed, or when nobody has written. */
  closesAt: Date | null;
}

export interface ReplyWindowRules {
  /** The standard window, in hours. */
  standardHours: number;
  /**
   * The extended window for a person replying, in hours, counted from the same
   * inbound message. Absent when the app is not approved for it.
   */
  humanAgentHours?: number | undefined;
}

const HOUR_MS = 60 * 60 * 1_000;

/**
 * The window a reply sent at `now` falls into.
 *
 * Counted from the person's **latest** message, not the first: every message
 * they send reopens the window, which is what lets a conversation continue
 * indefinitely while both sides are talking.
 *
 * A conversation in which the person has never written — only the brand has —
 * is closed. That is not an edge case to be generous about: writing first is
 * exactly what the rule forbids.
 */
export function replyWindow(input: {
  lastInboundAt: Date | null;
  now: Date;
  rules: ReplyWindowRules;
}): ReplyWindow {
  const { lastInboundAt, now, rules } = input;
  if (!lastInboundAt) return { state: 'CLOSED', closesAt: null };

  const standardEnds = new Date(lastInboundAt.getTime() + rules.standardHours * HOUR_MS);
  if (now < standardEnds) return { state: 'OPEN', closesAt: standardEnds };

  if (rules.humanAgentHours !== undefined && rules.humanAgentHours > rules.standardHours) {
    const agentEnds = new Date(lastInboundAt.getTime() + rules.humanAgentHours * HOUR_MS);
    if (now < agentEnds) return { state: 'HUMAN_AGENT', closesAt: agentEnds };
  }

  return { state: 'CLOSED', closesAt: null };
}
