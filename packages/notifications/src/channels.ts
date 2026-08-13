import type { NotificationChannel } from '@orbit/core';
import type { NotificationType } from './types.js';

/**
 * Which channels a notification goes out on — **the seam email will arrive
 * through** (T1.15, decision D-034).
 *
 * T1.15 ships in-app only. That is a deliberate scope decision, not an
 * oversight: sending mail is outward-facing, and switching it on is the user's
 * call to make once addresses are real.
 *
 * The shape here is what makes that later change cheap. Every producer already
 * calls `channelsFor` and writes one row per returned channel, so adding email
 * is:
 *
 *   1. return `'EMAIL'` from this function when the preference allows it;
 *   2. add an `EMAIL` branch to the notifications processor that reads rows
 *      where `channel = 'EMAIL' AND emailedAt IS NULL`, sends, and stamps
 *      `emailedAt`.
 *
 * No producer changes, no domain change, no migration — `NotificationChannel`
 * and `Notification.emailedAt` are already in the schema, and the row *is* the
 * outbox. A send that fails leaves the row unstamped and retryable, which is
 * why the in-app record can never be lost to an email problem (a T1.15 test
 * asserts exactly that).
 */

/**
 * Per-type opt-outs. Not persisted yet — `User` has no preferences column, and
 * adding one before there is a channel to opt out of would be a migration in
 * search of a purpose. When email lands it brings its own column and this
 * parameter starts being populated.
 */
export interface DeliveryPreferences {
  /** Absent means "not opted out". Default posture is on. */
  email?: Partial<Record<NotificationType, boolean>> | undefined;
}

/** Always delivered. There is no opting out of the in-app record. */
const IN_APP_ONLY: readonly NotificationChannel[] = ['IN_APP'];

export function channelsFor(
  _type: NotificationType,
  _preferences: DeliveryPreferences = {},
): readonly NotificationChannel[] {
  // Email is intentionally not returned yet. See the note above.
  return IN_APP_ONLY;
}

/**
 * Whether email is wired at all.
 *
 * Exported so the UI can tell the truth rather than offering preference toggles
 * that do nothing — a settings screen that silently ignores you is worse than
 * one that admits the feature is not built.
 */
export const EMAIL_DELIVERY_ENABLED = false;
