/**
 * What the product can tell someone about (SRS §22, T1.15).
 *
 * A closed union rather than free-form strings, because three separate things
 * key off it — the copy, the fan-out rule, and (later) the email preference —
 * and each of those is a total `Record<NotificationType, …>`. Adding a type is
 * therefore a compile error in every place that has to make a decision about it,
 * which is the only way a new notification cannot silently reach the wrong
 * people or nobody at all.
 */
export const NOTIFICATION_TYPES = [
  // Connections (T1.7)
  'social_account.needs_reconnect',
  'social_account.reconnected',
  // Approvals (T1.10)
  'post.approval_requested',
  'post.changes_requested',
  // Publishing (T1.13, T1.14)
  'publishing.failed',
  'publishing.needs_review',
  // The client's side of the review conversation.
  'post.client_review_requested',
  'post.approved',
  // Private messages (D-107).
  'message.received',
  // The AI assistant handed a conversation to a person (D-108).
  'message.needs_human',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export function isNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/**
 * Which surface a notification is written for.
 *
 * ## Why this exists at all
 *
 * The portal had no notifications, so every type was implicitly the agency's.
 * Now that a client can be told things, "who is this for" has to be a property
 * of the type rather than something each feed infers — because the two feeds
 * read the *same table*, and a person can be agency staff in one organization
 * and a client in another.
 *
 * Identity narrowing and tenant scoping both already apply (see `read.ts`), so
 * this is not the control that stops you reading someone else's inbox. It is
 * what stops **your own** agency-side notification appearing in a portal, where
 * its wording assumes a reader who works at the agency.
 *
 * ## It is enforced by the payload, not by the renderer
 *
 * A notification row is written once and read for years. Filtering an agency
 * name or a staff member's name out at render time would mean the row still
 * contained it — one query away from a client, and one refactor away from being
 * displayed. So a `CLIENT`-audience event simply never carries those facts.
 * There is nothing to leak because there is nothing stored.
 *
 * A total record, so adding a type does not compile until somebody has decided
 * who it is for.
 */
export type NotificationAudience = 'AGENCY' | 'CLIENT';

export const NOTIFICATION_AUDIENCE: Record<NotificationType, NotificationAudience> = {
  'social_account.needs_reconnect': 'AGENCY',
  'social_account.reconnected': 'AGENCY',
  'post.approval_requested': 'AGENCY',
  'post.changes_requested': 'AGENCY',
  'publishing.failed': 'AGENCY',
  'publishing.needs_review': 'AGENCY',

  // The only one a client is ever shown: their own gate opening.
  'post.client_review_requested': 'CLIENT',

  // A decision landing back with the agency — whoever made it.
  'post.approved': 'AGENCY',

  // Somebody is waiting for an answer in a private conversation.
  'message.received': 'AGENCY',
  'message.needs_human': 'AGENCY',
};

export function notificationTypesFor(audience: NotificationAudience): readonly NotificationType[] {
  return NOTIFICATION_TYPES.filter((type) => NOTIFICATION_AUDIENCE[type] === audience);
}

/**
 * The facts a notification is rendered from.
 *
 * Deliberately the *display* facts, resolved by the producer, not ids for the
 * renderer to chase. A notification row has to stay readable years later, when
 * the post may have been renamed or the account disconnected — so the title it
 * carries is the one that was true when it was written.
 */
export type NotificationEvent =
  | {
      type: 'social_account.needs_reconnect';
      accountName: string;
      /** The provider's safe explanation. Never provider JSON, never a token. */
      reason?: string | null | undefined;
    }
  | { type: 'social_account.reconnected'; accountName: string }
  | {
      type: 'post.approval_requested';
      postTitle: string;
      /** Which gate opened — internal review or the client's. */
      stage: 'INTERNAL' | 'CLIENT';
    }
  /**
   * Changes asked for, reported to whoever has to make them.
   *
   * `fromClient` is not cosmetic: a change request from inside the agency is an
   * internal step, and one from the client is the client saying no. The people
   * who act on it treat those differently, and the old copy said neither.
   */
  | {
      type: 'post.changes_requested';
      postTitle: string;
      note?: string | null | undefined;
      fromClient: boolean;
      by?: string | null | undefined;
    }
  | {
      type: 'publishing.failed';
      postTitle: string;
      accountName: string;
      /** From `presentFailure`, so the wording matches the publishing log. */
      summary: string;
    }
  | { type: 'publishing.needs_review'; postTitle: string; accountName: string }
  /**
   * The client's gate has opened and it is waiting on them.
   *
   * **Carries no agency facts at all** — no staff name, no reviewer, no note
   * about the internal rounds it went through before reaching them. The agency
   * speaks to its clients as one voice, and the enforcement is this type's
   * shape: there is no field here for a name, so no row can be written with
   * one.
   */
  | { type: 'post.client_review_requested'; postTitle: string }
  /**
   * Approved, and therefore clear to be scheduled.
   *
   * Nothing fired on this transition before — the agency found out a post had
   * been approved by going and looking, which for a client approval meant
   * refreshing the queue until something changed.
   *
   * `by` names the person because this is read by the agency, which already
   * knows its own staff and its own clients. `fromClient` is what the copy
   * needs: a client approval is the last gate and clears the post to go out,
   * where an internal one may not be.
   */
  | {
      type: 'post.approved';
      postTitle: string;
      fromClient: boolean;
      by?: string | null | undefined;
    }
  /**
   * A conversation needs somebody (D-107). Raised when one opens or reopens,
   * not for every message in it — a person writing five lines is one thing to
   * answer, not five.
   *
   * **No sender name and no message text.** Notification rows outlive the
   * twelve months a message is kept, and a person's private words do not
   * belong in a table built for "something happened". The conversation itself
   * is one click away.
   */
  | { type: 'message.received'; accountName: string }
  /**
   * The assistant could not or would not answer, and a person must (D-108).
   * Carries the kind of matter, never the customer's words or name.
   */
  | { type: 'message.needs_human'; accountName: string; reason: string };

/** Where a notification points when someone clicks it. */
export interface NotificationResource {
  resourceType: 'Post' | 'SocialAccount' | 'SocialConversation';
  resourceId: string;
  /** Governs who may be told. Every notification belongs to a workspace. */
  workspaceId: string;
  brandId?: string | null | undefined;
}
