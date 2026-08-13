import { ProviderErrorMap, parseRetryAfter, toAppError } from '../errors.js';
import type { AppError } from '@orbit/core';

/**
 * Meta Graph API error mapping.
 *
 * Graph returns HTTP 400 for almost everything, so the numeric `code` and
 * `error_subcode` carry the real meaning — classifying on status alone would
 * make every failure look like a validation problem and silently disable retry.
 */

export interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_title?: string;
    error_user_msg?: string;
    fbtrace_id?: string;
  };
}

export const facebookErrorMap = new ProviderErrorMap({
  // ── Authentication ────────────────────────────────────────────────────────
  '190': 'AUTHENTICATION', // access token problems; subcodes below
  '102': 'AUTHENTICATION', // session invalid
  '463': 'AUTHENTICATION', // token expired
  '467': 'AUTHENTICATION', // token invalid

  // ── Permission ────────────────────────────────────────────────────────────
  '10': 'PERMISSION', // permission denied
  '200': 'PERMISSION', // requires extended permission
  '210': 'PERMISSION', // user not visible
  '299': 'PERMISSION', // requires a permission not granted

  // ── Rate limiting ─────────────────────────────────────────────────────────
  '4': 'RATE_LIMIT', // application request limit
  '17': 'RATE_LIMIT', // user request limit
  '32': 'RATE_LIMIT', // page request limit
  '613': 'RATE_LIMIT', // calls to this api have exceeded the rate limit
  '80001': 'RATE_LIMIT', // pages posting rate limit
  '80004': 'RATE_LIMIT',

  // ── Media ─────────────────────────────────────────────────────────────────
  '324': 'MEDIA', // missing or invalid image file
  '389': 'MEDIA', // video upload problem
  '2207': 'MEDIA', // media upload

  // ── Validation ────────────────────────────────────────────────────────────
  '100': 'VALIDATION', // invalid parameter
  '368': 'VALIDATION', // action blocked by policy
  '506': 'VALIDATION', // duplicate post
  '1500': 'VALIDATION', // malformed URL

  // ── Transient ─────────────────────────────────────────────────────────────
  '1': 'UNAVAILABLE', // unknown/transient
  '2': 'UNAVAILABLE', // service temporarily unavailable
});

/**
 * Subcodes under error 190 that mean "a human must reauthorize", as distinct
 * from a token we could refresh. All map to AUTHENTICATION, but the message
 * differs and the reconnect prompt should say something true.
 */
const REAUTH_SUBCODES: Record<number, string> = {
  458: 'The app was removed from this account.',
  459: 'The account is checkpointed and needs attention on Facebook.',
  460: 'The password was changed, which invalidated the connection.',
  463: 'The connection expired.',
  464: 'The account is unconfirmed.',
  467: 'The connection is no longer valid.',
  492: 'This user no longer has access to the Page.',
};

export function reauthorizationReason(subcode: number | undefined): string | undefined {
  return subcode === undefined ? undefined : REAUTH_SUBCODES[subcode];
}

/**
 * Turn a Graph error response into a taxonomy error.
 *
 * `error_user_msg` is Meta's own end-user-safe text and is used as the
 * `userMessage` when present; `error.message` is developer-facing and may name
 * internal fields, so it never reaches a user.
 */
export function normalizeGraphError(
  body: GraphErrorBody,
  httpStatus: number,
  headers?: Headers,
): AppError {
  const error = body.error ?? {};
  const kind = facebookErrorMap.classify(error.code, httpStatus);
  const subcodeReason = reauthorizationReason(error.error_subcode);

  const retryAfterSeconds =
    kind === 'RATE_LIMIT'
      ? (parseRetryAfter(headers?.get('retry-after') ?? undefined) ?? estimateBackoff(headers))
      : undefined;

  return toAppError('FACEBOOK', {
    kind,
    message: error.message ?? `Graph API error (HTTP ${httpStatus})`,
    providerCode: error.code,
    httpStatus,
    retryAfterSeconds,
    meta: {
      ...(error.error_subcode !== undefined ? { subcode: error.error_subcode } : {}),
      ...(error.type ? { type: error.type } : {}),
      // Meta's support reference. Not sensitive, and the first thing they ask for.
      ...(error.fbtrace_id ? { fbtraceId: error.fbtrace_id } : {}),
      ...(subcodeReason ? { reauthorizationReason: subcodeReason } : {}),
    },
  });
}

/**
 * Meta reports usage as a percentage in `X-App-Usage` /
 * `X-Business-Use-Case-Usage` rather than a Retry-After. Near the ceiling we
 * back off proportionally instead of hammering until a hard block.
 */
function estimateBackoff(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined;

  const raw = headers.get('x-app-usage') ?? headers.get('x-business-use-case-usage');
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const values = collectPercentages(parsed);
    const peak = Math.max(0, ...values);

    if (peak >= 100) return 3600;
    if (peak >= 95) return 900;
    if (peak >= 90) return 300;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Meta reports every figure in these headers as a percentage of the ceiling —
 * `call_count`, `total_time`, `total_cputime`, and the business-use-case
 * equivalents. Any number in 0–100 is therefore a utilisation reading, so they
 * are collected by shape rather than by an ever-growing list of key names.
 */
function collectPercentages(value: unknown, depth = 0): number[] {
  if (depth > 4 || value === null || typeof value !== 'object') return [];

  if (Array.isArray(value)) return value.flatMap((v) => collectPercentages(v, depth + 1));

  return Object.entries(value).flatMap(([, entry]) =>
    typeof entry === 'number' && entry >= 0 && entry <= 100
      ? [entry]
      : collectPercentages(entry, depth + 1),
  );
}
