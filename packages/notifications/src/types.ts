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
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export function isNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value);
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
  | { type: 'post.changes_requested'; postTitle: string; note?: string | null | undefined }
  | {
      type: 'publishing.failed';
      postTitle: string;
      accountName: string;
      /** From `presentFailure`, so the wording matches the publishing log. */
      summary: string;
    }
  | { type: 'publishing.needs_review'; postTitle: string; accountName: string };

/** Where a notification points when someone clicks it. */
export interface NotificationResource {
  resourceType: 'Post' | 'SocialAccount';
  resourceId: string;
  /** Governs who may be told. Every notification belongs to a workspace. */
  workspaceId: string;
  brandId?: string | null | undefined;
}
