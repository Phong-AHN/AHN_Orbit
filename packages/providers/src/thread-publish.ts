import { clock, isAppError, type AppError, type Platform } from '@orbit/core';
import type { PlatformCapabilities } from './capabilities.js';
import { toAppError } from './errors.js';
import type { ThreadLink, ThreadProgress } from './thread.js';

/**
 * Publishing the rest of a thread once its first post is live (**D-124**).
 *
 * Shared by every adapter that can thread, so the one rule that matters is
 * written once: **a part is recorded the moment it is live, before the next
 * is attempted.** A retry then continues from the first part that is not,
 * rather than posting the thread a second time.
 *
 * ## Stopping part-way
 *
 * The engine gives one publish call a fixed budget and treats running out as
 * "the outcome is unknown". So no part is *started* after `deadlineMs`: the
 * adapter stops cleanly between two parts, with nothing in flight, and throws
 * a retryable error. The retry resumes where this left off. Stopping inside a
 * call instead would leave a part that may or may not exist — the one state
 * this design exists to avoid.
 *
 * A part the platform refuses is reported with how far the thread got, so the
 * failure on screen says "3 of 5 are live" rather than implying nothing went
 * out. Retrying it — automatically or by hand — continues from part 4.
 */

export interface ContinueThreadInput {
  platform: Platform;
  /** The platform's name as a person would write it, for messages. */
  label: string;
  /** Every part of the thread, the first included. */
  parts: readonly string[];
  /** What is live so far. Must already hold the first post. */
  progress: ThreadProgress;
  /** Epoch ms after which no further part is started. */
  deadlineMs: number;
  /** Post one part as a reply. Returns how to point at it. */
  postReply: (input: {
    text: string;
    /** 0-based position in `parts`. */
    index: number;
    parent: ThreadLink;
    root: ThreadLink;
  }) => Promise<ThreadLink>;
  /** Persist progress. Awaited: a part not recorded may be posted twice. */
  record: (progress: ThreadProgress) => Promise<void>;
}

export async function continueThread(input: ContinueThreadInput): Promise<ThreadProgress> {
  const { parts, platform, label } = input;
  const posted = [...input.progress.posted];
  const total = parts.length;
  const root = posted[0];

  if (!root) {
    throw new Error('continueThread needs the first post of the thread to be live already');
  }

  for (let index = posted.length; index < total; index += 1) {
    if (clock.nowMs() >= input.deadlineMs) {
      throw toAppError(platform, {
        kind: 'UNAVAILABLE',
        message: `Paused the thread after post ${index} of ${total} to stay inside the publish budget`,
        userMessage: `${index} of ${total} posts in this thread are live on ${label}. The rest will follow shortly.`,
        retryAfterSeconds: 5,
        meta: { threadPosted: index, threadTotal: total },
      });
    }

    const parent = posted[index - 1] as ThreadLink;
    let link: ThreadLink;
    try {
      link = await input.postReply({ text: parts[index] as string, index, parent, root });
    } catch (error) {
      throw withThreadProgress(error, { posted: index, total, label });
    }

    posted.push(link);
    await input.record({ fingerprint: input.progress.fingerprint, total, posted: [...posted] });
  }

  return { fingerprint: input.progress.fingerprint, total, posted };
}

/**
 * The same error, saying how far the thread got.
 *
 * Kept the same class so the engine's retry policy is untouched: a refused
 * part fails, an outage retries. An outcome that is genuinely unknown — a
 * timeout, an abort — is passed through as it is, for the engine to reconcile.
 */
function withThreadProgress(
  error: unknown,
  progress: { posted: number; total: number; label: string },
): unknown {
  if (!isAppError(error) || error.code === 'PUBLISHING_TIMEOUT') return error;

  const Ctor = Object.getPrototypeOf(error).constructor as new (
    message: string,
    options: Record<string, unknown>,
  ) => AppError;
  const provider = error as AppError & {
    platform?: string;
    providerCode?: string | number;
    httpStatus?: number;
  };

  return new Ctor(error.message, {
    platform: provider.platform,
    providerCode: provider.providerCode,
    httpStatus: provider.httpStatus,
    retryAfterSeconds: error.retryAfterSeconds,
    cause: error,
    userMessage: `${progress.posted} of ${progress.total} posts in this thread are live on ${progress.label}; the next one failed. ${error.userMessage} Retrying continues from post ${progress.posted + 1}.`,
    context: {
      ...error.context,
      threadPosted: progress.posted,
      threadTotal: progress.total,
    },
  });
}

/** Scopes a thread needs that this connection was not granted. */
export function missingThreadScopes(
  capabilities: PlatformCapabilities,
  granted: readonly string[],
): string[] {
  return capabilities.thread.scopes.filter((scope) => !granted.includes(scope));
}

/**
 * Refuse a thread on a connection that cannot reply, before anything is sent.
 *
 * The web validator says the same earlier; this is the adapter not trusting
 * that it was listened to. Without it the first post would go out and the
 * second would be refused, leaving a "thread" of one.
 */
export function assertThreadScopes(
  platform: Platform,
  label: string,
  capabilities: PlatformCapabilities,
  granted: readonly string[],
): void {
  const missing = missingThreadScopes(capabilities, granted);
  if (missing.length === 0) return;

  throw toAppError(platform, {
    kind: 'VALIDATION',
    message: `Refused before sending: a thread needs ${missing.join(', ')}, which this connection lacks`,
    userMessage: `This ${label} connection was made before threads were switched on, so it cannot reply to its own posts. Reconnect it, or turn off "Split into a thread".`,
    meta: { calledPlatform: false },
  });
}

/**
 * Refuse a thread whose first posts are live for text that has since changed.
 *
 * Publishing again would start a second thread beside the first. Nothing is
 * sent; somebody has to look at the account and decide.
 */
export function threadChangedRefusal(platform: Platform, label: string): AppError {
  return toAppError(platform, {
    kind: 'VALIDATION',
    message: 'Part of this thread is already live, but for text that has changed since',
    userMessage: `Part of this thread is already live on ${label}, but the text has changed since. Check the account before publishing again — publishing now would start a second thread.`,
    meta: { calledPlatform: false },
  });
}

/**
 * How far a thread got, from what the adapter recorded — for reconciliation.
 *
 *   • `undefined` — not a thread; reconcile the single post as always.
 *   • `COMPLETE` — every part is live; the thread is the first post.
 *   • `PARTIAL` — some parts are live and the next one's fate is unknown.
 *   • `NOT_STARTED` — the first post's fate is unknown; reconcile it as a
 *     single post, then pass the answer through `threadNotStarted`.
 */
export type ThreadState =
  | { state: 'COMPLETE'; head: ThreadLink; total: number }
  | { state: 'PARTIAL'; posted: number; total: number }
  | { state: 'NOT_STARTED'; total: number };

export function threadStateOf(
  providerRef: Record<string, unknown> | undefined,
): ThreadState | undefined {
  const raw = providerRef?.['thread'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;

  const { total, posted } = raw as { total?: unknown; posted?: unknown };
  if (typeof total !== 'number' || !Array.isArray(posted) || total < 2) return undefined;

  const head = posted[0] as ThreadLink | undefined;
  if (posted.length === 0 || !head || typeof head.id !== 'string') {
    return { state: 'NOT_STARTED', total };
  }
  if (posted.length >= total) return { state: 'COMPLETE', head, total };
  return { state: 'PARTIAL', posted: posted.length, total };
}

/**
 * A thread only part-way out, where the platform offers no way to post a part
 * exactly once.
 *
 * Never reported as published: the engine would stop, and the rest would
 * never go out. Nor as missing: a retry would repeat what is live. A person
 * looks at the account and decides.
 */
export function partialThread(
  posted: number,
  total: number,
  label: string,
): { outcome: 'INCONCLUSIVE'; reason: string } {
  return {
    outcome: 'INCONCLUSIVE',
    reason: `${posted} of ${total} posts in this thread are live on ${label}, and we could not confirm whether the next one went out. Check the account before retrying.`,
  };
}

/**
 * The first post's reconciliation, read as a thread's.
 *
 * Not found is still not found: nothing went out, so publishing is safe. Found
 * means the first post is live and — since nothing was recorded after it —
 * none of the rest are, which is again for a person to settle.
 */
export function threadNotStarted<T extends { outcome: string }>(
  single: T,
  total: number,
  label: string,
): T | { outcome: 'INCONCLUSIVE'; reason: string } {
  if (single.outcome !== 'FOUND') return single;
  return {
    outcome: 'INCONCLUSIVE',
    reason: `The first post of this ${total}-post thread is live on ${label}, but the rest did not go out. Post the rest by hand, or delete it there before retrying.`,
  };
}
