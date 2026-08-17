import { ProviderErrorMap, parseRetryAfter, toAppError } from '../errors.js';
import type { AppError } from '@orbit/core';

/**
 * TikTok error mapping.
 *
 * TikTok always returns an `error` object, **including on success**, where
 * `error.code` is the string `"ok"`. So a 200 is not evidence of anything: the
 * body has to be read before the status. That inverts the Meta habit and is the
 * single easiest thing to get wrong here.
 *
 * The codes are strings rather than numbers, and several of them are the
 * platform telling us about the *client's* standing rather than the request —
 * `unaudited_client_can_only_post_to_private_accounts` and
 * `reached_active_user_cap` are properties of our app, not of this post. Those
 * are separated out below because retrying them is pointless and the person who
 * needs to act is not the account manager.
 */

export interface TikTokErrorBody {
  error?: {
    code?: string;
    message?: string;
    log_id?: string;
  };
}

/** `error.code` on a successful response. Not a failure. */
export const TIKTOK_OK = 'ok';

export const tiktokErrorMap = new ProviderErrorMap({
  // ── Authentication ────────────────────────────────────────────────────────
  access_token_invalid: 'AUTHENTICATION',
  // The token is valid; the user never granted video.publish. A reconnect with
  // the right scope is the only fix, so it is an auth problem, not a permission
  // one — PERMISSION would be read as "a scope is missing from the app".
  scope_not_authorized: 'AUTHENTICATION',
  scope_permission_missed: 'AUTHENTICATION',

  // ── Rate limiting ─────────────────────────────────────────────────────────
  rate_limit_exceeded: 'RATE_LIMIT',
  // Verified: "The daily post cap from the API is reached for the current
  // user." A cap that resets, so it is a rate limit rather than a refusal.
  spam_risk_too_many_posts: 'RATE_LIMIT',
  spam_risk_too_many_pending_share: 'RATE_LIMIT',
  // Our whole client's daily ceiling, not this user's.
  reached_active_user_cap: 'RATE_LIMIT',

  // ── Permission ────────────────────────────────────────────────────────────
  // The user cannot post at all. Retrying tomorrow will not help.
  spam_risk_user_banned_from_posting: 'PERMISSION',
  unaudited_client_can_only_post_to_private_accounts: 'PERMISSION',

  // ── Validation ────────────────────────────────────────────────────────────
  invalid_param: 'VALIDATION',
  // The privacy level was not among the creator's own options. TikTok flags
  // repeated occurrences as a product-guidance violation.
  privacy_level_option_mismatch: 'VALIDATION',
  // PULL_FROM_URL against an unverified prefix. Cannot occur while Orbit uses
  // FILE_UPLOAD, and mapped anyway so it names itself if that ever changes.
  url_ownership_unverified: 'VALIDATION',
  file_format_check_failed: 'MEDIA',
  duration_check_failed: 'MEDIA',
  frame_rate_check_failed: 'MEDIA',
  picture_size_check_failed: 'MEDIA',
  video_pull_failed: 'MEDIA',
  photo_pull_failed: 'MEDIA',

  // ── Transient ─────────────────────────────────────────────────────────────
  internal_error: 'UNAVAILABLE',
});

/**
 * Codes that are about our app rather than this post.
 *
 * They surface to an account manager who can do nothing about them, so the
 * message says who *can* — an operator with access to the TikTok developer
 * portal. Saying "try again later" here would be a lie that costs somebody an
 * afternoon.
 */
const CLIENT_STANDING: Record<string, string> = {
  unaudited_client_can_only_post_to_private_accounts:
    'TikTok has not audited this app yet, so it can only post privately. An administrator needs to submit the app for audit.',
  reached_active_user_cap:
    "This app has reached TikTok's daily limit for publishing users. It resets tomorrow.",
};

/** Whether a body reports failure, regardless of the HTTP status. */
export function isTikTokFailure(body: TikTokErrorBody, httpStatus: number): boolean {
  const code = body.error?.code;
  if (code && code !== TIKTOK_OK) return true;
  return httpStatus >= 400;
}

/**
 * Turn a TikTok error body into a taxonomy error.
 *
 * `error.message` is developer-facing and may name internal fields, so it never
 * becomes a user message on its own — the only user-facing text that comes from
 * TikTok is the client-standing copy above, which we wrote.
 */
export function normalizeTikTokError(
  body: TikTokErrorBody,
  httpStatus: number,
  headers?: Headers,
): AppError {
  const error = body.error ?? {};
  const code = error.code;
  const kind = tiktokErrorMap.classify(code, httpStatus);

  const retryAfterSeconds =
    kind === 'RATE_LIMIT'
      ? (parseRetryAfter(headers?.get('retry-after') ?? undefined) ?? 60)
      : undefined;

  const standing = code ? CLIENT_STANDING[code] : undefined;

  return toAppError('TIKTOK', {
    kind,
    message: error.message ?? `TikTok error ${code ?? 'unknown'} (HTTP ${httpStatus})`,
    ...(code ? { providerCode: code } : {}),
    httpStatus,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(standing ? { userMessage: standing } : {}),
    meta: {
      // TikTok's own support reference. Not sensitive, and the first thing they
      // ask for.
      ...(error.log_id ? { logId: error.log_id } : {}),
      ...(standing ? { clientStanding: true } : {}),
    },
  });
}
