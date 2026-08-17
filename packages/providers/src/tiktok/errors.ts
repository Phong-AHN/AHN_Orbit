import {
  ProviderErrorMap,
  classifyHttpStatus,
  parseRetryAfter,
  toAppError,
  type ProviderErrorKind,
} from '../errors.js';
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

/**
 * The OAuth endpoints answer in a different shape from everything else.
 *
 * `/v2/oauth/token/` returns its fields at the **top level** — no `data`
 * wrapper — and reports failure as flat OAuth 2.0 strings rather than a nested
 * error object. Treating it like the rest of the API is not a cosmetic mistake:
 * unwrapping a `data` that is not there yields an empty object, the access
 * token comes back `undefined`, and the adapter reports "TikTok returned no
 * access token" — an authentication error for a request that in fact succeeded.
 *
 * That is exactly the bug this type exists to prevent, and it survived a green
 * test suite because the fake wrapped every response in `data` — the fixture
 * was wrong in the same way the code was.
 */
export interface TikTokOAuthErrorBody {
  error?: string;
  error_description?: string;
  log_id?: string;
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
  /**
   * Two remedies, and the order matters.
   *
   * The first version of this named only the audit — true, and useless to the
   * person reading it, who cannot submit an app and now believes TikTok is
   * blocked entirely. The immediate fix is a setting on this very post, and
   * saying so first is the difference between a two-second change and a wait of
   * several weeks.
   */
  unaudited_client_can_only_post_to_private_accounts:
    'TikTok has not audited this app yet, so it can only publish privately. Set this post’s visibility to "Only this account" to publish now — making posts public needs an administrator to submit the app for TikTok’s audit.',
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

/**
 * Standard OAuth 2.0 failure codes, as TikTok's token endpoint returns them.
 *
 * `invalid_grant` covers both an authorization code that was already used and a
 * refresh token TikTok no longer honours — different causes, same remedy: the
 * account has to be connected again.
 */
const OAUTH_KINDS: Record<string, ProviderErrorKind> = {
  invalid_client: 'AUTHENTICATION',
  invalid_grant: 'AUTHENTICATION',
  unauthorized_client: 'PERMISSION',
  access_denied: 'PERMISSION',
  invalid_request: 'VALIDATION',
  invalid_scope: 'VALIDATION',
  unsupported_grant_type: 'VALIDATION',
  slow_down: 'RATE_LIMIT',
};

/** Whether an OAuth response reports failure. */
export function isTikTokOAuthFailure(body: TikTokOAuthErrorBody, httpStatus: number): boolean {
  return Boolean(body.error) || httpStatus >= 400;
}

/**
 * Turn an OAuth failure into a taxonomy error.
 *
 * `error_description` is carried into the developer message, and it earns its
 * place: TikTok writes genuinely diagnostic text there — *"Redirect_uri is not
 * matched with the uri when requesting code"* names the problem outright, where
 * the code alone (`invalid_request`) names a category. Losing it is what turns
 * a five-minute fix into an afternoon (**D-085**).
 *
 * It stays a *developer* message. The user-facing copy is ours, because the
 * person who sees it can only ever do one thing about any of these.
 */
export function normalizeTikTokOAuthError(
  body: TikTokOAuthErrorBody,
  httpStatus: number,
): AppError {
  const code = body.error ?? 'unknown';
  const kind = OAUTH_KINDS[code] ?? classifyHttpStatus(httpStatus);

  return toAppError('TIKTOK', {
    kind,
    message: `TikTok OAuth refused: ${code}${body.error_description ? ` — ${body.error_description}` : ''}`,
    providerCode: code,
    httpStatus,
    meta: {
      ...(body.log_id ? { logId: body.log_id } : {}),
      // Says which half of the API answered, so a reader is not left wondering
      // why the shape differs from every other TikTok failure in the log.
      surface: 'oauth',
    },
  });
}
