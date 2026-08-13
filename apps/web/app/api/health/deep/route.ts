import { NextResponse } from 'next/server';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { describeEnv, serverEnv } from '@orbit/config';
import { clock } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { logError } from '@orbit/observability';
import { redis } from '@orbit/queue';
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

export async function GET() {
  const checks = await Promise.all([
    check('database', () => platformDb.$queryRaw`SELECT 1`),
    // Redis backs the queue, the per-account locks and the rate limiter. The
    // web app cannot publish, but it cannot *schedule* without this either.
    check('redis', () => redis().ping()),
    // A `HeadBucket` rather than a read: it proves reachability and credentials
    // without touching an object, so the probe cannot become a way to fetch one.
    check('storage', () => s3().send(new HeadBucketCommand({ Bucket: serverEnv().S3_BUCKET }))),
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
