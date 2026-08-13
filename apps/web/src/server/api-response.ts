import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import {
  type AppError,
  InternalError,
  TenantIsolationError,
  ValidationError,
  isAppError,
} from '@orbit/core';
import { currentCorrelationId, logError, logger } from '@orbit/observability';

/**
 * The single API error envelope (docs/API.md §1).
 *
 * Everything a handler throws funnels through here, so no route can
 * accidentally return a stack trace, a provider payload, or a SQL message.
 * The public shape carries only `code`, a safe `message`, field-level details,
 * retry hints, and the correlation id; everything else goes to the log under
 * that same id.
 */

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Array<{ field: string; issue: string }>;
    retryable: boolean;
    retryAfter?: number;
    correlationId?: string;
  };
}

export function jsonOk<T>(data: T, init?: ResponseInit): NextResponse<T> {
  return NextResponse.json(data, init);
}

export function jsonError(error: AppError): NextResponse<ApiErrorBody> {
  const correlationId = currentCorrelationId();
  const headers = new Headers();

  if (error.retryAfterSeconds !== undefined) {
    headers.set('Retry-After', String(error.retryAfterSeconds));
  }

  return NextResponse.json<ApiErrorBody>(
    { error: error.toPublicJSON(correlationId) as ApiErrorBody['error'] },
    { status: error.status, headers },
  );
}

/**
 * Normalise anything thrown into an AppError.
 *
 * Zod failures become field-level validation errors. An unknown throw becomes a
 * generic 500 — its message is never surfaced, because an unexpected error's
 * message is exactly the kind that leaks internals.
 */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error instanceof ZodError) {
    return new ValidationError('Request failed validation', {
      userMessage: 'Some of the information provided is not valid.',
      details: error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        issue: issue.message,
      })),
    });
  }

  return new InternalError('Unhandled error', { cause: error });
}

/** Convert a thrown value into a logged, safely-shaped HTTP response. */
export function handleRouteError(error: unknown, route: string): NextResponse<ApiErrorBody> {
  const appError = toAppError(error);

  // A cross-tenant attempt is a security event, not a routine 404.
  if (appError instanceof TenantIsolationError) {
    logger.error('tenant isolation violation', {
      route,
      securityEvent: true,
      ...appError.context,
    });
  } else {
    logError('request failed', appError, { route });
  }

  return jsonError(appError);
}
