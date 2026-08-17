import type { ErrorCode } from './errors.js';
import type { SocialAccountStatus } from './enums.js';

/**
 * Account health (SRS §14; docs/SOCIAL_PROVIDERS.md §4; T1.7).
 *
 * Health is **probe-driven, not expiry-driven**. A Facebook Page token generally
 * has no expiry at all, and yet it dies the moment the granting user changes
 * their password, loses access to the Page, or revokes a permission. An expiry
 * timestamp would therefore say "fine" right up until the first failed publish.
 * The only way to know is to ask the platform.
 *
 * Everything here is pure, because the same three questions get asked from three
 * places — the health sweep in the worker, the publish engine when a call comes
 * back unauthenticated, and the web request behind the health endpoint — and
 * three copies of these answers would drift. The persistence differs per caller;
 * the decisions do not.
 */

/**
 * How often an account is re-probed by the sweep.
 *
 * An hour is a compromise between two costs. Probing more often spends provider
 * quota on accounts that are almost always fine; probing less often widens the
 * window in which a dead token looks healthy on the dashboard. An hour keeps the
 * dashboard honest within one scheduling cycle for most agencies, and the
 * publish path catches anything that breaks in between (it never trusts a stale
 * verdict — it fails on the live call and demotes the account there and then).
 */
export const HEALTH_PROBE_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * Has this account gone long enough without a probe to be worth one?
 *
 * The same predicate is applied twice on purpose: once when the sweep decides
 * what to enqueue, and again inside the processor before it calls the provider.
 * The second check is not redundant — a job can sit in the queue behind a
 * backlog, or be retried, and by the time it runs someone may have probed the
 * account from the UI. Re-asking costs one comparison and saves a provider call.
 */
export function isProbeDue(
  healthCheckedAt: Date | null | undefined,
  now: Date,
  minIntervalMs: number = HEALTH_PROBE_INTERVAL_MS,
): boolean {
  // Never probed. Nothing is known about it, which is the strongest reason to ask.
  if (!healthCheckedAt) return true;
  return now.getTime() - healthCheckedAt.getTime() >= minIntervalMs;
}

/**
 * What a failed provider call implies about the *account*, as opposed to the
 * post that happened to be in flight.
 *
 * Most publishing failures say nothing about the connection: a caption too long,
 * a video the platform rejected, a rate limit, an outage. Exactly two say the
 * credential itself is no longer good enough, and both have the same remedy —
 * send the user back through OAuth:
 *
 *   • `PROVIDER_AUTHENTICATION_ERROR` — the token is dead or revoked.
 *   • `PROVIDER_PERMISSION_ERROR` — the token lives, but a scope we need was
 *     never granted or has since been withdrawn. Reconnecting is what re-asks
 *     for it, which is already what `ProviderPermissionError.userMessage` tells
 *     the user to do.
 *
 * Returning `null` for everything else is the important half of this function.
 * Demoting an account because one post was malformed would pause publishing for
 * every other post on it, which is a far worse outcome than the original error.
 */
export function accountStatusForErrorCode(code: ErrorCode): SocialAccountStatus | null {
  switch (code) {
    case 'PROVIDER_AUTHENTICATION_ERROR':
    case 'PROVIDER_PERMISSION_ERROR':
      return 'NEEDS_RECONNECT';
    default:
      return null;
  }
}

export interface HealthChange {
  /** The verdict differs from what is stored, so the row needs updating. */
  changed: boolean;
  /** The account has just become unusable. This is what people need telling about. */
  degraded: boolean;
  /** The account was unusable and is now fine again. */
  recovered: boolean;
}

/**
 * Compare a fresh verdict against what we already believed.
 *
 * The reason this exists rather than being inlined: an hourly sweep across a
 * broken account would otherwise generate a notification every hour, forever.
 * Notifying on the **transition** rather than on the state means one alert when
 * it breaks and, at most, one when it is fixed — which is the difference between
 * an alert people act on and an alert people filter.
 *
 * `DISABLED` and `REVOKED` are deliberately not "degraded": both are states a
 * person put the account into (a staged row mid-OAuth, or a deliberate
 * disconnection). Announcing them as breakages would be reporting the user's own
 * action back to them as a problem.
 */
export function classifyHealthChange(
  previous: SocialAccountStatus,
  next: SocialAccountStatus,
): HealthChange {
  const changed = previous !== next;

  return {
    changed,
    degraded: changed && next === 'NEEDS_RECONNECT',
    recovered: changed && previous === 'NEEDS_RECONNECT' && next === 'ACTIVE',
  };
}

/**
 * The words a person reads when an account breaks live in
 * `@orbit/notifications` (`content.ts`), not here.
 *
 * T1.7 shipped them in this file because there was nowhere better. T1.15 gave
 * notification copy one home, keyed by a closed `NotificationType`, so every
 * notification the product sends is written in one place and rendered the same
 * way. `packages/core` keeps only the health *decisions* — which is the split
 * that lets `@orbit/notifications` depend on core rather than the reverse.
 */

/**
 * Whether a failure is about **our application** rather than this account.
 *
 * Some platform refusals arrive as permission errors and are nothing to do with
 * the connection: TikTok's `unaudited_client_can_only_post_to_private_accounts`
 * and `reached_active_user_cap` are properties of the API client, identical for
 * every account on the platform, and no amount of reconnecting will change
 * either.
 *
 * Demoting on one of these does active harm. It takes a perfectly good account
 * out of service, tells an account manager to reconnect it, and sends them
 * through an OAuth round trip that resolves nothing — while the real remedy
 * sits with an administrator and the developer portal. It happened: a sandbox
 * TikTok app failed one post and left the account marked NEEDS_RECONNECT.
 *
 * Adapters signal it by setting `clientStanding: true` in the error context.
 * The flag is a cross-provider convention rather than a TikTok detail — any
 * platform that distinguishes "your app may not do this" from "this connection
 * is broken" reports it the same way.
 */
export function isClientStandingFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const context = (error as { context?: Record<string, unknown> }).context;
  return context?.['clientStanding'] === true;
}
