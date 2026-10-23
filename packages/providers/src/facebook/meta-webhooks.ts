import { createHmac } from 'node:crypto';
import { clock } from '@orbit/core';
import { safeEquals } from '../credential-cipher.js';
import type { DirectMessage, MessageAttachment, ProviderEvent } from '../types.js';

/**
 * What Facebook Pages and Instagram share about webhooks and private messages
 * (**D-107**).
 *
 * Both adapters receive the same envelope — `entry[].messaging[]` for messages,
 * `entry[].changes[]` for everything else — signed the same way and verified
 * with the same handshake. It lives here once, inside the provider layer, so
 * neither the webhook route nor the worker ever reads a Meta field name.
 */

/** Meta's standard messaging window. */
export const META_STANDARD_WINDOW_HOURS = 24;
/** The Human Agent extension, for a reply typed by a person. */
export const META_HUMAN_AGENT_WINDOW_HOURS = 7 * 24;

/**
 * How a deployment has set up Meta messaging. Both switches come from the
 * environment and reach the adapters through their options.
 */
export interface MetaMessagingOptions {
  /** Ask for the messaging scopes, subscribe to messages, offer the inbox. */
  enabled: boolean;
  /** Approved for the Human Agent tag: reply for seven days instead of one. */
  humanAgent?: boolean | undefined;
}

/** The `messaging` section of a descriptor, or "not supported". */
export function messagingDescriptor(
  options: MetaMessagingOptions | undefined,
  input: { scopes: readonly string[]; maxMessageLength: number; maxMessageBytes?: number },
) {
  if (!options?.enabled) return { supported: false };

  return {
    supported: true,
    replyWindowHours: META_STANDARD_WINDOW_HOURS,
    ...(options.humanAgent ? { humanAgentWindowHours: META_HUMAN_AGENT_WINDOW_HOURS } : {}),
    maxMessageLength: input.maxMessageLength,
    ...(input.maxMessageBytes ? { maxMessageBytes: input.maxMessageBytes } : {}),
    scopes: input.scopes,
  };
}

/**
 * Answer the subscription handshake.
 *
 * Meta sends `hub.mode=subscribe`, the verify token configured in the App
 * Dashboard, and a challenge to echo back. Without a configured token nothing
 * is accepted: an endpoint that echoed any challenge would let anybody
 * subscribe it to anything.
 */
export function metaWebhookChallenge(
  query: Record<string, string | undefined>,
  verifyToken: string | undefined,
): string | null {
  if (!verifyToken) return null;
  if (query['hub.mode'] !== 'subscribe') return null;

  const offered = query['hub.verify_token'];
  if (!offered || !safeEquals(offered, verifyToken)) return null;

  return query['hub.challenge'] ?? null;
}

/**
 * `X-Hub-Signature-256` over the raw body.
 *
 * **The raw body, byte for byte.** Meta signs what it sent, which escapes
 * non-ASCII characters; hashing a re-serialised object instead gives a
 * different answer for any message with an accent in it — which, for a
 * Vietnamese audience, is nearly every message.
 *
 * Several secrets are accepted because Meta does not sign every product with
 * the same one: Business Login for Instagram has an app secret of its own, and
 * which of the two signs its webhooks is not stated in the documentation. Each
 * candidate is ours, so accepting either refuses nobody who could not forge
 * the other.
 */
export function verifyMetaSignature(
  rawBody: string,
  header: string | undefined,
  secrets: ReadonlyArray<string | undefined>,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const offered = header.slice('sha256='.length);

  return secrets.some((secret) => {
    if (!secret) return false;
    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    return safeEquals(offered, expected);
  });
}

// ── Payload parsing ─────────────────────────────────────────────────────────

interface MessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    is_deleted?: boolean;
    attachments?: Array<{ type?: string; payload?: { url?: string } }>;
  };
}

interface Entry {
  id?: string;
  time?: number;
  messaging?: MessagingEvent[];
  changes?: Array<{ field?: string; value?: Record<string, unknown> }>;
}

/**
 * Parse a delivery into the core's events.
 *
 * Tolerant of shape and strict about meaning. A body that is not JSON, or an
 * entry without an account id, yields nothing rather than an error: the route
 * has already verified the signature, so this is Meta's payload, and a field
 * we do not understand is a kind we do not use. Throwing would make Meta retry
 * a delivery that can never parse, for thirty-six hours.
 */
export function parseMetaWebhook(
  rawBody: string,
  commentField: (change: {
    field?: string;
    value?: Record<string, unknown>;
  }) => { externalPostId: string; commentId: string } | null,
): ProviderEvent[] {
  let body: { entry?: Entry[] };
  try {
    body = JSON.parse(rawBody) as { entry?: Entry[] };
  } catch {
    return [];
  }

  const events: ProviderEvent[] = [];

  for (const entry of body.entry ?? []) {
    const accountExternalId = entry.id;
    if (!accountExternalId) continue;

    for (const event of entry.messaging ?? []) {
      const parsed = parseMessagingEvent(accountExternalId, event);
      if (parsed) events.push(parsed);
    }

    for (const change of entry.changes ?? []) {
      const comment = commentField(change);
      if (!comment) continue;
      events.push({
        kind: 'COMMENT_ACTIVITY',
        externalEventId: `comment:${comment.commentId}`,
        accountExternalId,
        externalPostId: comment.externalPostId,
        occurredAt: entry.time ? fromMetaTime(entry.time) : clock.now(),
      });
    }
  }

  return events;
}

/**
 * One `messaging[]` item, or null for kinds the inbox does not use.
 *
 * Reactions, read receipts, postbacks and referrals arrive on the same array
 * without a `message`, and are dropped here.
 *
 * Which side is the person depends on direction: on a message they sent,
 * they are the sender; on an echo of one the brand sent — from Orbit or from
 * the platform's own app — they are the recipient.
 */
function parseMessagingEvent(
  accountExternalId: string,
  event: MessagingEvent,
): ProviderEvent | null {
  const message = event.message;
  if (!message?.mid) return null;

  const outbound = message.is_echo === true;
  const participantExternalId = outbound ? event.recipient?.id : event.sender?.id;
  if (!participantExternalId) return null;

  const attachments: MessageAttachment[] = (message.attachments ?? [])
    .filter((attachment) => Boolean(attachment.type))
    .map((attachment) => ({
      type: String(attachment.type),
      ...(attachment.payload?.url ? { url: attachment.payload.url } : {}),
    }));

  const parsed: DirectMessage = {
    externalId: message.mid,
    participantExternalId,
    direction: outbound ? 'OUTBOUND' : 'INBOUND',
    ...(message.text ? { text: message.text } : {}),
    attachments,
    sentAt: event.timestamp ? fromMetaTime(event.timestamp) : clock.now(),
  };

  const deleted = message.is_deleted === true;

  return {
    kind: 'MESSAGE',
    // A deletion reuses the message's id, so it needs its own event id or the
    // deduplication would drop it as a retry of the original.
    externalEventId: `message:${message.mid}${deleted ? ':deleted' : ''}`,
    accountExternalId,
    message: parsed,
    ...(deleted ? { deleted: true } : {}),
  };
}

/**
 * Meta timestamps are milliseconds on `messaging[]` and seconds on `entry`.
 * Told apart by size rather than by field, so a payload that mixes them up is
 * still read correctly.
 */
function fromMetaTime(value: number): Date {
  return new Date(value < 1e12 ? value * 1_000 : value);
}
