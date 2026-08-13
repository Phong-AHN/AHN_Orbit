import { NextResponse } from 'next/server';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { describeEnv, serverEnv } from '@orbit/config';
import { clock } from '@orbit/core';
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

async function check(name: string, fn: () => Promise<unknown>): Promise<Check> {
  const started = Date.now();
  try {
    await fn();
    return { name, ok: true, latencyMs: Date.now() - started };
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
    const queue = queueFor('publish');
    const [workers, waiting, delayed] = await Promise.all([
      queue.getWorkersCount(),
      queue.getWaitingCount(),
      queue.getDelayedCount(),
    ]);

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

export async function GET() {
  const checks = await Promise.all([
    check('database', () => platformDb.$queryRaw`SELECT 1`),
    // Redis backs the queue, the per-account locks and the rate limiter. The
    // web app cannot publish, but it cannot *schedule* without this either.
    check('redis', () => redis().ping()),
    // A `HeadBucket` rather than a read: it proves reachability and credentials
    // without touching an object, so the probe cannot become a way to fetch one.
    check('storage', () => s3().send(new HeadBucketCommand({ Bucket: serverEnv().S3_BUCKET }))),
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
