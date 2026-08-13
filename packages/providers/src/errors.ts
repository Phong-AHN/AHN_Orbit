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
