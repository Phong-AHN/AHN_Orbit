import type { ErrorCode } from './errors.js';

/**
 * How a publishing failure is explained to a person (SRS §14, §37).
 *
 * Every code in the taxonomy gets a plain-language description and — more
 * usefully — **what to do about it**. A log that says
 * `PROVIDER_PERMISSION_ERROR` tells an operator nothing they can act on; one
 * that says "this account is missing a permission, reconnect it and grant
 * publishing access" tells them exactly what to click.
 *
 * Pure and exhaustive over `ErrorCode`, so adding an error to the taxonomy is a
 * type error here until someone decides how to explain it. That is deliberate:
 * an unexplained failure code reaching a user is a worse outcome than a
 * compile break.
 */

export type FailureAction =
  /** Reconnect the social account, then retry. */
  | 'RECONNECT_ACCOUNT'
  /** Change the post, then retry. */
  | 'EDIT_CONTENT'
  /** Replace or remove an attached file. */
  | 'FIX_MEDIA'
  /** Retrying unchanged is reasonable. */
  | 'RETRY'
  /** Nothing to do but wait; the system will retry on its own. */
  | 'WAIT'
  /** A person must establish what happened before anything else. */
  | 'REVIEW'
  /** Support or engineering needs to look. */
  | 'CONTACT_SUPPORT';

export interface FailurePresentation {
  /** One line, safe to show anyone including a client. */
  summary: string;
  /** What the reader should do next. */
  action: FailureAction;
  /** Whether an automated retry could plausibly succeed. */
  retryable: boolean;
}

const PRESENTATIONS: Record<ErrorCode, FailurePresentation> = {
  // ── Provider (SRS §37) ────────────────────────────────────────────────────
  PROVIDER_AUTHENTICATION_ERROR: {
    summary: 'The connection to this account has expired or been revoked.',
    action: 'RECONNECT_ACCOUNT',
    retryable: false,
  },
  PROVIDER_PERMISSION_ERROR: {
    summary: 'This account is missing a permission needed to publish.',
    action: 'RECONNECT_ACCOUNT',
    retryable: false,
  },
  PROVIDER_VALIDATION_ERROR: {
    summary: 'The platform rejected the content of this post.',
    action: 'EDIT_CONTENT',
    retryable: false,
  },
  PROVIDER_MEDIA_ERROR: {
    summary: 'The platform rejected an attached image or video.',
    action: 'FIX_MEDIA',
    retryable: false,
  },
  PROVIDER_RATE_LIMIT: {
    summary: 'The platform is limiting how often we can post to this account.',
    action: 'WAIT',
    retryable: true,
  },
  PROVIDER_UNAVAILABLE: {
    summary: 'The platform was unreachable.',
    action: 'WAIT',
    retryable: true,
  },
  PUBLISHING_TIMEOUT: {
    // The one that matters most: it is not a failure, it is an unknown.
    summary:
      'The platform never confirmed whether this post went out, so we stopped rather than risk posting it twice.',
    action: 'REVIEW',
    retryable: false,
  },

  // ── Domain ────────────────────────────────────────────────────────────────
  INVALID_STATE_TRANSITION: {
    summary: 'This post had already moved on by the time publishing ran.',
    action: 'REVIEW',
    retryable: false,
  },
  TENANT_ISOLATION_VIOLATION: {
    summary: 'A permissions problem stopped this from publishing.',
    action: 'CONTACT_SUPPORT',
    retryable: false,
  },
  PLAN_LIMIT_EXCEEDED: {
    summary: 'This organization has reached a plan limit.',
    action: 'CONTACT_SUPPORT',
    retryable: false,
  },

  // ── Transport / request ───────────────────────────────────────────────────
  VALIDATION_ERROR: {
    summary: 'The post was not valid for this platform.',
    action: 'EDIT_CONTENT',
    retryable: false,
  },
  UNAUTHENTICATED: {
    summary: 'The connection to this account is no longer authorised.',
    action: 'RECONNECT_ACCOUNT',
    retryable: false,
  },
  FORBIDDEN: {
    summary: 'This account is not permitted to publish.',
    action: 'RECONNECT_ACCOUNT',
    retryable: false,
  },
  NOT_FOUND: {
    summary: 'Something this post needed no longer exists.',
    action: 'REVIEW',
    retryable: false,
  },
  CONFLICT: {
    summary: 'This post changed while it was being published.',
    action: 'REVIEW',
    retryable: false,
  },
  RATE_LIMITED: {
    summary: 'Too many requests. We will slow down and try again.',
    action: 'WAIT',
    retryable: true,
  },
  PAYLOAD_TOO_LARGE: {
    summary: 'An attached file was too large for the platform.',
    action: 'FIX_MEDIA',
    retryable: false,
  },
  INTERNAL_ERROR: {
    summary: 'Something went wrong on our side.',
    action: 'RETRY',
    retryable: true,
  },
};

/**
 * Explain a failure code.
 *
 * Codes the engine writes that are not in the taxonomy — the human-resolution
 * markers from T1.14 — are handled explicitly rather than falling through to a
 * generic message, because they are not failures at all.
 */
export function presentFailure(code: string | null | undefined): FailurePresentation {
  if (!code) {
    return {
      summary: 'Publishing has not been attempted yet.',
      action: 'WAIT',
      retryable: false,
    };
  }

  switch (code) {
    case 'RESOLVED_BY_HUMAN':
      return {
        summary: 'Someone confirmed this had published after checking the platform.',
        action: 'REVIEW',
        retryable: false,
      };
    case 'RETRY_AFTER_REVIEW':
      return {
        summary: 'Someone confirmed this had not published, and it was queued again.',
        action: 'WAIT',
        retryable: true,
      };
    case 'ABANDONED_BY_HUMAN':
      return {
        summary: 'Someone decided not to publish this account.',
        action: 'REVIEW',
        retryable: false,
      };
    default:
      break;
  }

  return (
    PRESENTATIONS[code as ErrorCode] ?? {
      summary: 'Publishing failed for an unexpected reason.',
      action: 'CONTACT_SUPPORT',
      retryable: false,
    }
  );
}

/** Whether a failure is worth offering a retry button for. */
export function isRetryOffered(code: string | null | undefined): boolean {
  const presentation = presentFailure(code);
  return presentation.retryable || presentation.action === 'RETRY';
}
