import { NextResponse } from 'next/server';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { probeIdentityProvider } from '@orbit/auth';
import { describeEnv, serverEnv } from '@orbit/config';
import { clock, withProbeBudget } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { logError } from '@orbit/observability';
import { queueFor, redis } from '@orbit/queue';
import { s3 } from '@orbit/storage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Dependency check, feeding the admin panel's API-health view (SRS §28).
 *
 * Reports configuration by *presence* only — never a value — so this endpoint
 * can never become a way to read secrets (SRS §33).
 */

interface Check {
  name: string;
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

/**
 * Every probe answers inside this, or it is reported as unreachable.
 *
 * Chosen to sit well inside a serverless function's own limit. The checks run
 * in parallel, so the worst case for the whole response is one budget plus
 * serialisation — which is the property that matters: **this endpoint must
 * always answer.**
 *
 * It did not, once. On a deployment whose `DATABASE_URL` pointed at a host with
 * no reachable address, the TCP connect simply waited; the request was still
 * open after 90 seconds and the function died without reporting anything. The
 * endpoint that existed to name the broken component was the only thing in the
 * system that could not.
 */
const PROBE_BUDGET_MS = 5_000;

async function check(name: string, fn: () => Promise<unknown>): Promise<Check> {
  const started = Date.now();
  try {
    const outcome = await withProbeBudget(fn, PROBE_BUDGET_MS);

    if (outcome.timedOut) {
      logError(`health check timed out: ${name}`, new Error('probe budget elapsed'), {
        check: name,
        budgetMs: PROBE_BUDGET_MS,
      });
      return {
        name,
        ok: false,
        latencyMs: outcome.elapsedMs,
        // Said apart from "unreachable" on purpose: a refused connection means
        // nothing is listening, while a timeout means something is and never
        // replied. Those point at different problems — a wrong host versus a
        // firewall, a saturated pool, or an address with no route to it.
        detail: `no response within ${PROBE_BUDGET_MS}ms`,
      };
    }

    return { name, ok: true, latencyMs: outcome.elapsedMs };
  } catch (error) {
    logError(`health check failed: ${name}`, error, { check: name });
    return {
      name,
      ok: false,
      latencyMs: Date.now() - started,
      // A generic reason: the real one is in the log, keyed by correlation id.
      detail: 'unreachable',
    };
  }
}

/**
 * Is anything consuming the queues?
 *
 * The web app produces jobs and never consumes them, so "Redis is reachable"
 * says nothing about whether work is being done. Without this, a post stuck in
 * SCHEDULED looks identical whether the worker is dead or the time simply has
 * not arrived — and the first is an outage while the second is normal.
 *
 * BullMQ registers each running worker as a named Redis client, so the answer
 * is already in Redis; nothing new has to be written or polled.
 */
async function workerCheck(): Promise<Check> {
  const started = Date.now();

  try {
    const outcome = await withProbeBudget(async () => {
      const queue = queueFor('publish');
      return Promise.all([
        queue.getWorkersCount(),
        queue.getWaitingCount(),
        queue.getDelayedCount(),
      ]);
    }, PROBE_BUDGET_MS);

    if (outcome.timedOut) {
      return {
        name: 'worker',
        ok: false,
        latencyMs: outcome.elapsedMs,
        detail: `no response within ${PROBE_BUDGET_MS}ms`,
      };
    }

    const [workers, waiting, delayed] = outcome.value ?? [0, 0, 0];

    return {
      name: 'worker',
      ok: workers > 0,
      latencyMs: Date.now() - started,
      ...(workers > 0
        ? { detail: `${workers} consuming, ${waiting} waiting, ${delayed} delayed` }
        : {
            detail:
              waiting + delayed > 0
                ? `no worker consuming; ${waiting + delayed} job(s) queued`
                : 'no worker consuming',
          }),
    };
  } catch (error) {
    logError('health check failed: worker', error, { check: 'worker' });
    return { name: 'worker', ok: false, latencyMs: Date.now() - started, detail: 'unreachable' };
  }
}

/**
 * Can anybody sign in?
 *
 * The other checks cover the things a request needs *after* authentication, and
 * every one of them can be green while sign-in is impossible — which is exactly
 * the outage that is hardest to place, because the app looks fine until a
 * person tries to get in.
 *
 * The reason is a category, never a message: this route answers without a
 * session, so it has to be useful to an operator and useless to anyone else.
 */
async function authCheck(): Promise<Check> {
  const started = Date.now();

  try {
    const outcome = await withProbeBudget(probeIdentityProvider, PROBE_BUDGET_MS);

    if (outcome.timedOut || !outcome.value) {
      return {
        name: 'auth',
        ok: false,
        latencyMs: outcome.elapsedMs,
        detail: `no response within ${PROBE_BUDGET_MS}ms`,
      };
    }

    const result = outcome.value;

    return {
      name: 'auth',
      ok: result.ok,
      latencyMs: outcome.elapsedMs,
      ...(result.ok ? {} : { detail: REASONS[result.reason] }),
    };
  } catch (error) {
    logError('health check failed: auth', error, { check: 'auth' });
    return { name: 'auth', ok: false, latencyMs: Date.now() - started, detail: 'unreachable' };
  }
}

/** Each reason says where to look, without saying anything about the key. */
const REASONS: Record<string, string> = {
  NOT_CONFIGURED: 'FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY is not set',
  CREDENTIAL_REJECTED:
    'the service account was rejected — wrong project, revoked key, or a malformed private key',
  UNREACHABLE: 'the identity provider could not be reached',
};

export async function GET() {
  const checks = await Promise.all([
    check('database', () => platformDb.$queryRaw`SELECT 1`),
    // Redis backs the queue, the per-account locks and the rate limiter. The
    // web app cannot publish, but it cannot *schedule* without this either.
    check('redis', () => redis().ping()),
    // A `HeadBucket` rather than a read: it proves reachability and credentials
    // without touching an object, so the probe cannot become a way to fetch one.
    check('storage', () => s3().send(new HeadBucketCommand({ Bucket: serverEnv().S3_BUCKET }))),
    // Listed with the dependencies because that is what it is: without it the
    // app is reachable, healthy, and impossible to enter.
    authCheck(),
    workerCheck(),
  ]);

  const healthy = checks.every((c) => c.ok);

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
      service: 'web',
      time: clock.now().toISOString(),
      checks,
      config: describeEnv(),
    },
    { status: healthy ? 200 : 503 },
  );
}
