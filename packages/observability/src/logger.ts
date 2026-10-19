import { AsyncLocalStorage } from 'node:async_hooks';
import pino, { type Logger as PinoLogger } from 'pino';
import { serverEnv } from '@orbit/config';
import { isAppError, newCorrelationId } from '@orbit/core';
import { redact } from './redact.js';

/**
 * Structured logging (SRS §33).
 *
 * Every line carries a `correlationId` threaded browser → API → queue → worker
 * → provider, so one publish can be traced end to end in a single query. The
 * id travels in AsyncLocalStorage rather than being passed through every
 * signature, and is copied onto queue payloads at enqueue time.
 */

export interface LogContext {
  correlationId: string;
  organizationId?: string;
  userId?: string;
  [key: string]: unknown;
}

const storage = new AsyncLocalStorage<LogContext>();

const base = pino({
  level: serverEnv().LOG_LEVEL,
  base: {
    env: serverEnv().APP_ENV,
    service: process.env.ORBIT_SERVICE ?? 'web',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Second line of defence. The primary one is `redact()` on every payload;
  // this catches anything constructed as a top-level field.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.accessToken',
      '*.refreshToken',
      '*.password',
      '*.clientSecret',
    ],
    censor: '[redacted]',
  },
});

type Bindings = Record<string, unknown>;

function merged(bindings?: Bindings): Bindings {
  const ctx = storage.getStore();
  return redact({ ...(ctx ?? {}), ...(bindings ?? {}) });
}

export interface Logger {
  trace(msg: string, bindings?: Bindings): void;
  debug(msg: string, bindings?: Bindings): void;
  info(msg: string, bindings?: Bindings): void;
  warn(msg: string, bindings?: Bindings): void;
  error(msg: string, bindings?: Bindings): void;
  fatal(msg: string, bindings?: Bindings): void;
  child(bindings: Bindings): Logger;
}

function wrap(instance: PinoLogger): Logger {
  const at =
    (level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal') =>
    (msg: string, bindings?: Bindings) =>
      instance[level](merged(bindings), msg);

  return {
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: (bindings: Bindings) => wrap(instance.child(redact(bindings))),
  };
}

export const logger: Logger = wrap(base);

/** Run `fn` with a logging context attached to everything it logs. */
export function withLogContext<T>(context: Partial<LogContext>, fn: () => T): T {
  const parent = storage.getStore();
  return storage.run(
    {
      ...(parent ?? {}),
      ...context,
      correlationId: context.correlationId ?? parent?.correlationId ?? newCorrelationId(),
    },
    fn,
  );
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function currentLogContext(): LogContext | undefined {
  return storage.getStore();
}

/**
 * Log a thrown value at the right level and shape.
 *
 * Expected application errors (a 404, a validation failure) are `warn` and
 * carry their structured context. Anything else is `error` with a stack —
 * because an unexpected exception is the thing worth waking someone for.
 *
 * **`reason` is the developer-facing `message`, and it is not optional.** It
 * was omitted here originally on the reasoning that `code` and `context` say
 * enough. They do not: a publish that failed with
 * `PROVIDER_VALIDATION_ERROR` and a context of `{ platform: 'INSTAGRAM' }` is
 * indistinguishable from a dozen different causes, and the one thing that named
 * the cause — "Draft failed validation: MEDIA_REQUIRED" — was being dropped on
 * the floor. It is called `reason` rather than `message` because the log line's
 * own `msg` already owns that name.
 *
 * It is the *developer* message, never `userMessage`, and it must stay that
 * way: `AppError.message` may name internal fields, but it is written by us and
 * never contains a credential or a token. Provider text arrives already
 * normalized — Meta's `error_user_msg` is the only thing lifted into a user
 * message, and it is Meta's own end-user-safe copy.
 */
/**
 * The chain of `cause`s under an error, flattened for a log line.
 *
 * An `InternalError('Unhandled error')` carries the real failure as its
 * `cause`, and that cause may itself wrap another. Without this the log says
 * only that *something* went wrong — a dead Redis, a Prisma failure and a typo
 * all produce the identical line, and a production incident starts with no
 * information at all.
 *
 * Bounded at four links. A cycle would otherwise spin here, and anything
 * deeper is a wrapper chain nobody reads to the end of.
 *
 * This is for the **log**, never the HTTP response: an unexpected error's
 * message is exactly the kind that leaks internals, which is why `toAppError`
 * replaces it on the way out and why that must stay.
 */
function causeChain(error: unknown): Array<{ message: string; stack?: string }> {
  const chain: Array<{ message: string; stack?: string }> = [];
  const seen = new Set<unknown>();
  let current: unknown = (error as { cause?: unknown } | undefined)?.cause;

  while (current !== undefined && current !== null && chain.length < 4) {
    if (seen.has(current)) break;
    seen.add(current);

    chain.push(
      current instanceof Error
        ? { message: current.message, ...(current.stack ? { stack: current.stack } : {}) }
        : { message: String(current) },
    );

    current = (current as { cause?: unknown }).cause;
  }

  return chain;
}

export function logError(msg: string, error: unknown, bindings?: Bindings): void {
  if (isAppError(error)) {
    const causes = causeChain(error);
    const payload = {
      ...bindings,
      code: error.code,
      status: error.status,
      retryable: error.retryable,
      reason: error.message,
      errorContext: error.context,
      // Only when there is one, so a deliberate AppError stays a clean line.
      ...(causes.length > 0 ? { causes } : {}),
    };
    if (error.status >= 500) logger.error(msg, { ...payload, stack: error.stack });
    else logger.warn(msg, payload);
    return;
  }

  logger.error(msg, {
    ...bindings,
    err: error instanceof Error ? error : { message: String(error) },
  });
}
