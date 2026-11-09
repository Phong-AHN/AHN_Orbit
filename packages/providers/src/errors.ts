import {
  ProviderAuthenticationError,
  ProviderMediaError,
  ProviderPermissionError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  ProviderValidationError,
  PublishingTimeoutError,
  isAppError,
  type AppError,
  type Platform,
} from '@orbit/core';

/**
 * Provider error normalization (SRS §37).
 *
 * Every adapter funnels its failures through here, so the publishing engine
 * decides retry policy from one taxonomy instead of learning each platform's
 * error codes. An adapter supplies only what is genuinely platform-specific:
 * a map from its own codes to ours.
 *
 * The retry policy each class implies (docs/ARCHITECTURE.md §5.2):
 *   AUTHENTICATION → never retry; mark NEEDS_RECONNECT and notify
 *   RATE_LIMIT     → reschedule at retryAfter; does not consume an attempt
 *   VALIDATION     → never retry; the content is wrong, not the moment
 *   MEDIA          → never retry
 *   PERMISSION     → never retry; a scope is missing
 *   UNAVAILABLE    → retry with backoff
 *   TIMEOUT        → reconcile before any retry; outcome is unknown
 */

export type ProviderErrorKind =
  | 'AUTHENTICATION'
  | 'RATE_LIMIT'
  | 'VALIDATION'
  | 'MEDIA'
  | 'PERMISSION'
  | 'UNAVAILABLE'
  | 'TIMEOUT';

export interface NormalizedProviderFailure {
  kind: ProviderErrorKind;
  message: string;
  providerCode?: string | number | undefined;
  httpStatus?: number | undefined;
  retryAfterSeconds?: number | undefined;
  /**
   * Overrides the taxonomy default, which assumes the platform answered.
   *
   * Needed for the failures we raise *before* calling anybody: the default
   * copy — "the platform rejected this post" — is a plain untruth when nothing
   * was ever sent, and it sends whoever reads it looking in the wrong place.
   */
  userMessage?: string | undefined;
  /** Non-sensitive provider fields worth keeping on the attempt row (SRS §14). */
  meta?: Record<string, string | number | boolean> | undefined;
}

const CONSTRUCTORS: Record<
  ProviderErrorKind,
  new (message: string, options: Record<string, unknown>) => AppError
> = {
  AUTHENTICATION: ProviderAuthenticationError,
  RATE_LIMIT: ProviderRateLimitError,
  VALIDATION: ProviderValidationError,
  MEDIA: ProviderMediaError,
  PERMISSION: ProviderPermissionError,
  UNAVAILABLE: ProviderUnavailableError,
  TIMEOUT: PublishingTimeoutError,
};

/** Build the taxonomy error for a normalized failure. */
export function toAppError(platform: Platform, failure: NormalizedProviderFailure): AppError {
  const Ctor = CONSTRUCTORS[failure.kind];

  return new Ctor(failure.message, {
    platform,
    providerCode: failure.providerCode,
    httpStatus: failure.httpStatus,
    retryAfterSeconds: failure.retryAfterSeconds,
    // Spread rather than assigned: `undefined` here would beat the constructor's
    // default instead of falling through to it.
    ...(failure.userMessage ? { userMessage: failure.userMessage } : {}),
    context: {
      platform,
      providerCode: failure.providerCode,
      httpStatus: failure.httpStatus,
      ...failure.meta,
    },
  });
}

/**
 * Default classification from an HTTP status.
 *
 * Adapters override with their own code mapping first and fall back to this;
 * a platform that returns 200 with an error body must classify before calling.
 */
export function classifyHttpStatus(status: number): ProviderErrorKind {
  if (status === 401) return 'AUTHENTICATION';
  if (status === 403) return 'PERMISSION';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status === 413 || status === 415) return 'MEDIA';
  if (status >= 400 && status < 500) return 'VALIDATION';
  return 'UNAVAILABLE';
}

/**
 * What an OAuth token endpoint's refusal says, and about whom (RFC 6749 §5.2).
 *
 * Every adapter renews tokens at an endpoint that speaks the same standard,
 * and each used to read its refusals its own way. Three of them took a 401 as
 * "this account's token is dead" and two took `invalid_client` the same way —
 * but the standard is plain that both are about **the client**: our app id,
 * secret or signing key. A worker holding a wrong or rotated secret then told
 * every account on that platform to reconnect, and reconnecting fixed nothing,
 * because the next renewal from the same worker failed the same way.
 * Meanwhile Google answers a dead refresh token with `invalid_grant` on a 400,
 * which the status alone read as a bad request rather than a dead connection.
 *
 * - `invalid_grant` — the refresh token is spent, revoked or expired. Only a
 *   person can fix that, so it is AUTHENTICATION.
 * - `invalid_client`, `unauthorized_client`, `unsupported_grant_type`, or a
 *   401 with no code — our credentials or configuration. UNAVAILABLE and
 *   marked `clientStanding`, so no account is demoted for it and the message
 *   points at the person who can act.
 * - Anything else falls back to the caller's reading of the status.
 *
 * `grantCodes` lets a platform add its own word for a dead refresh token: X
 * answers a spent one with `invalid_request`.
 */
export function tokenEndpointFailure(
  platform: Platform,
  input: {
    status: number;
    code?: string | undefined;
    description?: string | undefined;
    grantCodes?: readonly string[] | undefined;
    fallback: (status: number) => ProviderErrorKind;
    meta?: Record<string, string | number | boolean> | undefined;
  },
): AppError {
  const code = input.code;
  const label = PLATFORM_LABEL[platform] ?? platform;
  const message = `${label} OAuth refused: ${code ?? input.status}${
    input.description ? ` — ${input.description}` : ''
  }`;

  const common = {
    message,
    ...(code ? { providerCode: code } : {}),
    httpStatus: input.status,
  };

  if (code === 'invalid_grant' || (code && input.grantCodes?.includes(code))) {
    return toAppError(platform, {
      ...common,
      kind: 'AUTHENTICATION',
      ...(input.meta ? { meta: input.meta } : {}),
    });
  }

  const aboutTheClient =
    (code !== undefined && OAUTH_CLIENT_CODES.has(code)) ||
    (code === undefined && input.status === 401);

  if (aboutTheClient) {
    return toAppError(platform, {
      ...common,
      kind: 'UNAVAILABLE',
      userMessage: `${label} refused Social Square's own app credentials. An administrator needs to check them; reconnecting the account will not help.`,
      meta: { ...input.meta, clientStanding: true },
    });
  }

  return toAppError(platform, {
    ...common,
    kind: input.fallback(input.status),
    ...(input.meta ? { meta: input.meta } : {}),
  });
}

/** The RFC 6749 codes that are about the client, never about the account. */
const OAUTH_CLIENT_CODES = new Set([
  'invalid_client',
  'unauthorized_client',
  'unsupported_grant_type',
]);

const PLATFORM_LABEL: Partial<Record<Platform, string>> = {
  X: 'X',
  YOUTUBE: 'Google',
  TIKTOK: 'TikTok',
  LINKEDIN: 'LinkedIn',
  PINTEREST: 'Pinterest',
  BLUESKY: 'Bluesky',
};

/** `Retry-After` accepts seconds or an HTTP date; both are handled. */
export function parseRetryAfter(header: string | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);

  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - now) / 1000));

  return undefined;
}

/**
 * Last-resort normalization for anything an adapter did not classify.
 *
 * A network abort becomes `TIMEOUT` rather than a generic failure, because the
 * publish outcome is genuinely unknown and must be reconciled — treating it as
 * a plain error is how double-posts happen.
 */
export function normalizeUnknownError(platform: Platform, error: unknown): AppError {
  if (isAppError(error)) return error;

  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';

  const isAbort =
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    /timeout|timed out|aborted|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message);

  return toAppError(platform, {
    kind: isAbort ? 'TIMEOUT' : 'UNAVAILABLE',
    message: isAbort
      ? 'The platform did not respond in time; the outcome is unknown.'
      : 'The platform could not be reached.',
    meta: { originalName: name || 'unknown' },
  });
}

/**
 * A code→kind lookup, so an adapter declares its mapping as data.
 *
 * Longest-prefix matching keeps entries like `190` (Meta's OAuth error) usable
 * without listing every subcode.
 */
export class ProviderErrorMap {
  private readonly entries: ReadonlyArray<[string, ProviderErrorKind]>;

  constructor(mapping: Record<string, ProviderErrorKind>) {
    this.entries = Object.entries(mapping).sort((a, b) => b[0].length - a[0].length);
  }

  classify(code: string | number | undefined, httpStatus?: number): ProviderErrorKind {
    if (code !== undefined) {
      const asString = String(code);
      for (const [prefix, kind] of this.entries) {
        if (asString === prefix || asString.startsWith(`${prefix}.`)) return kind;
      }
    }
    return classifyHttpStatus(httpStatus ?? 500);
  }
}

/**
 * Refuse a draft that our own pre-flight rejected, before any network call.
 *
 * Every adapter re-runs `validate` at the top of `publish`, because the moment
 * a job actually runs is later than the moment it was queued and the content
 * may have moved since. What that refusal must *not* do is dress itself up as
 * the platform's answer.
 *
 * The failure this replaces reported `PROVIDER_VALIDATION_ERROR` with a context
 * of `{ platform }`, told the user "the platform rejected this post", and put
 * the only text naming the real problem into a `message` the logger dropped.
 * Meta had never been called. Somebody reading that goes looking at Instagram
 * for a post Instagram never saw.
 *
 * So: the codes go into the structured context where they can be searched and
 * counted, the first error's own wording becomes the user message, and the
 * developer message says plainly that this never left the building. The
 * taxonomy code stays `PROVIDER_VALIDATION_ERROR` — it is still correctly
 * non-retryable, since retrying unchanged content fails the same way.
 */
export function preflightRefusal(
  platform: Platform,
  result: {
    issues: ReadonlyArray<{ severity: string; code: string; field: string; message: string }>;
  },
): NormalizedProviderFailure {
  const errors = result.issues.filter((issue) => issue.severity === 'ERROR');
  const codes = errors.map((issue) => issue.code);

  return {
    kind: 'VALIDATION',
    message: `Refused before sending: the draft failed our own ${platform} checks (${codes.join(', ') || 'no code'})`,
    // The first error is the one to act on. Listing all of them turns a fixable
    // problem into a wall of text in a toast.
    userMessage: errors[0]?.message ?? 'This post is not valid for this platform.',
    meta: {
      validationCodes: codes.join(','),
      validationFields: errors.map((issue) => issue.field).join(','),
      // States outright what the generic copy got wrong.
      calledPlatform: false,
    },
  };
}
