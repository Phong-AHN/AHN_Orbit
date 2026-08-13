/**
 * Application error taxonomy (SRS §37).
 *
 * One base class carrying a stable machine `code`, an HTTP `status`, a
 * `userMessage` that is safe to render verbatim, and structured `context` that
 * is *never* rendered — it goes to the structured log under the same
 * correlation id (SRS §33).
 *
 * Provider errors are normalised into this taxonomy by the adapter layer, so
 * the publishing engine and the UI never see a raw Meta/Google error shape
 * (SRS §8, §37).
 */

export const ERROR_CODES = [
  // ── Transport / request ───────────────────────────────────────────────────
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL_ERROR',

  // ── Domain ────────────────────────────────────────────────────────────────
  'INVALID_STATE_TRANSITION',
  'TENANT_ISOLATION_VIOLATION',
  'PLAN_LIMIT_EXCEEDED',

  // ── Provider (SRS §37, verbatim) ──────────────────────────────────────────
  'PROVIDER_AUTHENTICATION_ERROR',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_VALIDATION_ERROR',
  'PROVIDER_MEDIA_ERROR',
  'PROVIDER_PERMISSION_ERROR',
  'PROVIDER_UNAVAILABLE',
  'PUBLISHING_TIMEOUT',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface FieldIssue {
  field: string;
  issue: string;
}

export interface AppErrorOptions {
  /** Safe to display to an end user. Never contains implementation detail. */
  userMessage?: string;
  /** Structured diagnostic data. Logged, never rendered. */
  context?: Record<string, unknown>;
  /** Field-level problems, safe to display. */
  details?: FieldIssue[];
  /** Seconds until a retry could reasonably succeed. */
  retryAfterSeconds?: number;
  cause?: unknown;
}

export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly status: number;
  /** Whether an automated retry could plausibly succeed. Drives queue policy. */
  readonly retryable: boolean = false;

  readonly userMessage: string;
  readonly context: Record<string, unknown>;
  readonly details: FieldIssue[];
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.userMessage = options.userMessage ?? message;
    this.context = options.context ?? {};
    this.details = options.details ?? [];
    this.retryAfterSeconds = options.retryAfterSeconds;
    Error.captureStackTrace?.(this, new.target);
  }

  /** The public shape. Deliberately excludes `context`, `stack`, and `cause`. */
  toPublicJSON(correlationId?: string) {
    return {
      code: this.code,
      message: this.userMessage,
      details: this.details.length > 0 ? this.details : undefined,
      retryable: this.retryable,
      retryAfter: this.retryAfterSeconds,
      correlationId,
    };
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

// ── Transport / request ──────────────────────────────────────────────────────

export class ValidationError extends AppError {
  override readonly code = 'VALIDATION_ERROR' as const;
  override readonly status = 400;
}

export class UnauthenticatedError extends AppError {
  override readonly code = 'UNAUTHENTICATED' as const;
  override readonly status = 401;
  constructor(message = 'Authentication required', options: AppErrorOptions = {}) {
    super(message, { userMessage: 'Please sign in to continue.', ...options });
  }
}

export class ForbiddenError extends AppError {
  override readonly code = 'FORBIDDEN' as const;
  override readonly status = 403;
  constructor(message = 'Permission denied', options: AppErrorOptions = {}) {
    super(message, {
      userMessage: "You don't have permission to do that.",
      ...options,
    });
  }
}

/**
 * Also the response for a resource that exists in another tenant. Returning 403
 * there would confirm the resource exists (docs/API.md §1, docs/RBAC.md §7).
 */
export class NotFoundError extends AppError {
  override readonly code = 'NOT_FOUND' as const;
  override readonly status = 404;
  constructor(resource = 'Resource', options: AppErrorOptions = {}) {
    super(`${resource} not found`, {
      userMessage: `That ${resource.toLowerCase()} could not be found.`,
      ...options,
    });
  }
}

export class ConflictError extends AppError {
  override readonly code = 'CONFLICT' as const;
  override readonly status = 409;
}

export class RateLimitedError extends AppError {
  override readonly code = 'RATE_LIMITED' as const;
  override readonly status = 429;
  override readonly retryable = true;
  constructor(message = 'Rate limit exceeded', options: AppErrorOptions = {}) {
    super(message, {
      userMessage: 'Too many requests. Please wait a moment and try again.',
      ...options,
    });
  }
}

export class PayloadTooLargeError extends AppError {
  override readonly code = 'PAYLOAD_TOO_LARGE' as const;
  override readonly status = 413;
}

export class InternalError extends AppError {
  override readonly code = 'INTERNAL_ERROR' as const;
  override readonly status = 500;
  constructor(message = 'Internal error', options: AppErrorOptions = {}) {
    super(message, {
      userMessage: 'Something went wrong on our side. The team has been notified.',
      ...options,
    });
  }
}

// ── Domain ───────────────────────────────────────────────────────────────────

export class InvalidStateTransitionError extends AppError {
  override readonly code = 'INVALID_STATE_TRANSITION' as const;
  override readonly status = 409;
  constructor(from: string, to: string, options: AppErrorOptions = {}) {
    super(`Illegal transition ${from} → ${to}`, {
      userMessage: `This can't move from ${humanise(from)} to ${humanise(to)}.`,
      context: { from, to, ...options.context },
      ...options,
    });
  }
}

/**
 * Raised when a query or job payload reaches across an organization boundary.
 * Always a bug or an attack — logged as a security event, never surfaced with
 * detail (SRS §4).
 */
export class TenantIsolationError extends AppError {
  override readonly code = 'TENANT_ISOLATION_VIOLATION' as const;
  override readonly status = 404;
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, {
      userMessage: 'That resource could not be found.',
      ...options,
    });
  }
}

export class PlanLimitExceededError extends AppError {
  override readonly code = 'PLAN_LIMIT_EXCEEDED' as const;
  override readonly status = 403;
}

// ── Provider (SRS §37) ───────────────────────────────────────────────────────

export interface ProviderErrorOptions extends AppErrorOptions {
  platform?: string;
  providerCode?: string | number;
  httpStatus?: number;
}

abstract class ProviderError extends AppError {
  readonly platform: string | undefined;
  readonly providerCode: string | number | undefined;
  readonly httpStatus: number | undefined;

  constructor(message: string, options: ProviderErrorOptions = {}) {
    super(message, options);
    this.platform = options.platform;
    this.providerCode = options.providerCode;
    this.httpStatus = options.httpStatus;
  }
}

/**
 * The token is dead or its scopes were revoked. Never retried — retrying a dead
 * token only burns quota. Marks the account NEEDS_RECONNECT and notifies
 * (SRS §14, docs/SOCIAL_PROVIDERS.md §4).
 */
export class ProviderAuthenticationError extends ProviderError {
  override readonly code = 'PROVIDER_AUTHENTICATION_ERROR' as const;
  override readonly status = 502;
  override readonly retryable = false;
  constructor(message = 'Provider authentication failed', options: ProviderErrorOptions = {}) {
    super(message, {
      userMessage: 'This social account needs to be reconnected before it can publish again.',
      ...options,
    });
  }
}

export class ProviderRateLimitError extends ProviderError {
  override readonly code = 'PROVIDER_RATE_LIMIT' as const;
  override readonly status = 429;
  override readonly retryable = true;
  constructor(message = 'Provider rate limit reached', options: ProviderErrorOptions = {}) {
    super(message, {
      userMessage: "The platform is limiting requests right now. We'll retry automatically.",
      ...options,
    });
  }
}

/**
 * Both of these carry a safe default user message. Without one, `AppError`
 * falls back to the technical `message` — which for a provider error is the
 * platform's own text, and may name internal fields or endpoints. An adapter
 * that has something genuinely useful to say passes `userMessage` explicitly.
 */
export class ProviderValidationError extends ProviderError {
  override readonly code = 'PROVIDER_VALIDATION_ERROR' as const;
  override readonly status = 422;
  override readonly retryable = false;
  constructor(message = 'Provider rejected the content', options: ProviderErrorOptions = {}) {
    super(message, {
      userMessage: 'The platform rejected this post. Check the content and try again.',
      ...options,
    });
  }
}

export class ProviderMediaError extends ProviderError {
  override readonly code = 'PROVIDER_MEDIA_ERROR' as const;
  override readonly status = 422;
  override readonly retryable = false;
  constructor(message = 'Provider rejected the media', options: ProviderErrorOptions = {}) {
    super(message, {
      userMessage: "The platform wouldn't accept this image or video.",
      ...options,
    });
  }
}

export class ProviderPermissionError extends ProviderError {
  override readonly code = 'PROVIDER_PERMISSION_ERROR' as const;
  override readonly status = 403;
  override readonly retryable = false;
  constructor(message = 'Provider permission denied', options: ProviderErrorOptions = {}) {
    super(message, {
      userMessage:
        'The connected account is missing a permission this action needs. Reconnect it and grant the requested access.',
      ...options,
    });
  }
}

export class ProviderUnavailableError extends ProviderError {
  override readonly code = 'PROVIDER_UNAVAILABLE' as const;
  override readonly status = 503;
  override readonly retryable = true;
  constructor(message = 'Provider unavailable', options: ProviderErrorOptions = {}) {
    super(message, {
      userMessage: "The platform isn't responding right now. We'll retry automatically.",
      ...options,
    });
  }
}

/**
 * The outcome is genuinely unknown — the post may or may not exist. NOT
 * retryable on its own: the publish worker must reconcile before it may try
 * again (docs/ARCHITECTURE.md §5.2 layer 4).
 */
export class PublishingTimeoutError extends ProviderError {
  override readonly code = 'PUBLISHING_TIMEOUT' as const;
  override readonly status = 504;
  override readonly retryable = false;
  constructor(
    message = 'Publish timed out with an unknown outcome',
    options: ProviderErrorOptions = {},
  ) {
    super(message, {
      userMessage:
        "We didn't get a clear answer from the platform. We're checking whether the post went out before trying again.",
      ...options,
    });
  }
}

function humanise(token: string): string {
  return token.toLowerCase().replace(/_/g, ' ');
}
