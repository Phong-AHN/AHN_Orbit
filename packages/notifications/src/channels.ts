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
const IN_APP_AND_EMAIL: readonly NotificationChannel[] = ['IN_APP', 'EMAIL'];

/**
 * Which types earn an email, and which do not (**D-080**).
 *
 * The test is simple and it is not "is this important": it is **would somebody
 * want to be interrupted, away from the product, to know this?**
 *
 * Four qualify, and each fails silently if nobody is told:
 *
 * - `social_account.needs_reconnect` — publishing to that account is broken
 *   until a human signs in again, and nothing else will surface it.
 * - `publishing.failed` and `publishing.needs_review` — a client's post did not
 *   go out. At 2am, in-app means nobody knows until morning.
 * - `post.approval_requested` — the whole approval workflow stalls on somebody
 *   who may not open the product that day. This is the one that makes the
 *   product usable by clients who log in weekly.
 *
 * `post.changes_requested` and `social_account.reconnected` stay in-app.
 * The first reaches somebody already working in the product; the second is good
 * news about a thing they just did, and an email for it is noise.
 */
const EMAIL_WORTHY: ReadonlySet<NotificationType> = new Set([
  'social_account.needs_reconnect',
  'publishing.failed',
  'publishing.needs_review',
  'post.approval_requested',
]);

export function channelsFor(
  type: NotificationType,
  preferences: DeliveryPreferences = {},
): readonly NotificationChannel[] {
  if (!EMAIL_DELIVERY_ENABLED) return IN_APP_ONLY;
  if (!EMAIL_WORTHY.has(type)) return IN_APP_ONLY;

  // An explicit `false` opts out; absent means "not opted out", so the default
  // posture stays on and a user who has never touched preferences still hears
  // about a failed publish.
  if (preferences.email?.[type] === false) return IN_APP_ONLY;

  return IN_APP_AND_EMAIL;
}

/**
 * Whether email is wired at all.
 *
 * Reads the environment rather than a constant: a deployment with no mail
 * provider configured writes no `EMAIL` rows at all, so the outbox stays empty
 * instead of filling with messages nothing will ever send.
 *
 * Exported so the UI can tell the truth rather than offering preference toggles
 * that do nothing — a settings screen that silently ignores you is worse than
 * one that admits the feature is not built.
 */
export const EMAIL_DELIVERY_ENABLED = Boolean(process.env['RESEND_API_KEY']);
