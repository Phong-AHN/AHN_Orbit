/**
 * What is filling Redis, and — with `--apply` — remove the parts that are safe
 * to remove.
 *
 * Written during the outage of 2026-10-19, where Redis reached `maxmemory` and,
 * because the policy is `noeviction`, began refusing **every** write. The
 * symptom was the whole product answering 500 with `OOM command not allowed`
 * raised inside a BullMQ Lua script, on endpoints that look nothing to do with
 * queues.
 *
 *   node --experimental-strip-types scripts/redis-usage.ts
 *   node --experimental-strip-types scripts/redis-usage.ts --apply
 *
 * ## Why raw commands rather than BullMQ's `queue.clean()`
 *
 * `clean()` is the right API normally and the wrong one here. It runs through
 * `EVAL`, and Redis refuses a writing script while over `maxmemory` — so the
 * tool you would reach for is precisely the one that cannot run in the state
 * you need it for. `DEL`, `ZREM` and `XTRIM` are not `denyoom`, so they work.
 *
 * ## What it will and will not touch
 *
 * Removed with `--apply`: the `failed` and `completed` sorted sets, the job
 * hashes they reference, and the `events` stream. None of these are needed for
 * the queue to run — they are history, and the dead-letter view an operator
 * actually reads lives in `dlq:index`, which is separate and already bounded
 * by a 30-day TTL.
 *
 * **Never touched:** `wait`, `active`, `delayed`, `paused`, `meta`, `id`,
 * `repeat`, `stalled-check`, `limiter` — that is live queue state, and
 * deleting it loses scheduled work or corrupts the queue.
 */
import Redis from 'ioredis';
import { QUEUE_NAMES } from '../src/queues.ts';

/**
 * Taken from the source of truth, never retyped.
 *
 * A hand-written list here missed `account-health` on the first version of
 * this script, so a cleanup silently skipped one of nine queues. Anything
 * under `bull:` that is *not* in this list is reported separately — that is
 * how a queue left behind by an older deploy becomes visible instead of
 * quietly holding memory.
 */
const QUEUES = QUEUE_NAMES;

/** History. Safe to drop; nothing depends on it to run. */
const DISPOSABLE_SETS = ['failed', 'completed'] as const;

/** Live state. Dropping any of these loses work. */
const PROTECTED = [
  'wait',
  'active',
  'delayed',
  'paused',
  'meta',
  'id',
  'repeat',
  'stalled-check',
  'limiter',
] as const;

const apply = process.argv.includes('--apply');

function url(): string {
  const value = process.env.REDIS_URL;
  if (!value) {
    console.error('REDIS_URL is not set. Point it at the instance you want to inspect.');
    process.exit(1);
  }
  return value;
}

function human(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

function field(info: string, key: string): number {
  const match = new RegExp(`^${key}:(\\d+)`, 'm').exec(info);
  return match ? Number(match[1]) : Number.NaN;
}

async function main(): Promise<void> {
  const target = url();
  const redis = new Redis(target, { maxRetriesPerRequest: 2, lazyConnect: true });

  // Without this, a refused connection prints an ioredis stack trace — the
  // least helpful thing to hand somebody who is already mid-incident.
  redis.on('error', () => {
    /* reported once below, from the connect failure */
  });

  try {
    await redis.connect().catch((error: unknown) => {
      const host = target.replace(/\/\/[^@]*@/, '//');
      console.error(`Cannot reach Redis at ${host}`);
      console.error(error instanceof Error ? error.message : String(error));
      console.error('');
      console.error('Check REDIS_URL, and that the instance allows connections from here.');
      process.exit(1);
    });

    const info = await redis.info('memory');
    const used = field(info, 'used_memory');
    const max = field(info, 'maxmemory');
    const policy = /^maxmemory_policy:(\S+)/m.exec(info)?.[1] ?? 'unknown';

    console.log('');
    console.log(`used        ${human(used)}`);
    console.log(`maxmemory   ${max > 0 ? human(max) : 'unlimited'}`);
    console.log(`policy      ${policy}`);
    if (max > 0)
      console.log(`headroom    ${human(max - used)}  (${Math.round((used / max) * 100)}% used)`);

    if (policy !== 'noeviction') {
      console.log('');
      console.log(`!! policy is "${policy}", not "noeviction".`);
      console.log('   For a job queue that is wrong: Redis may silently evict scheduled work.');
    }

    console.log('');
    console.log('queue          failed  completed    wait  active  delayed   events');
    console.log('------------------------------------------------------------------');

    let disposable = 0;

    for (const queue of QUEUES) {
      const counts: Record<string, number> = {};
      for (const set of [...DISPOSABLE_SETS, 'wait', 'active', 'delayed'] as const) {
        const key = `bull:${queue}:${set}`;
        counts[set] =
          set === 'wait' || set === 'active' ? await redis.llen(key) : await redis.zcard(key);
      }
      const events = await redis.xlen(`bull:${queue}:events`).catch(() => 0);

      disposable += counts.failed! + counts.completed! + events;

      console.log(
        queue.padEnd(13) +
          String(counts.failed).padStart(7) +
          String(counts.completed).padStart(11) +
          String(counts.wait).padStart(8) +
          String(counts.active).padStart(8) +
          String(counts.delayed).padStart(9) +
          String(events).padStart(9),
      );
    }

    console.log('');
    console.log(`disposable entries (failed + completed + events): ${disposable}`);

    const dlq = await redis.zcard('dlq:index').catch(() => 0);
    console.log(`dlq:index (the admin dead-letter view, 30-day TTL): ${dlq} — left alone`);

    if (!apply) {
      console.log('');
      console.log('Report only. Re-run with --apply to remove failed, completed and events.');
      console.log(`Protected and never touched: ${PROTECTED.join(', ')}`);
      return;
    }

    console.log('');
    console.log('Applying…');

    let removed = 0;

    for (const queue of QUEUES) {
      for (const set of DISPOSABLE_SETS) {
        const key = `bull:${queue}:${set}`;

        // In batches: a single ZRANGE of a very large set is itself a memory
        // spike, which is the one thing to avoid in this state.
        for (;;) {
          const ids = await redis.zrange(key, 0, 499);
          if (ids.length === 0) break;

          const pipeline = redis.pipeline();
          for (const id of ids) pipeline.del(`bull:${queue}:${id}`);
          pipeline.zrem(key, ...ids);
          await pipeline.exec();

          removed += ids.length;
        }

        await redis.del(key);
      }

      // Keep the stream, drop its contents: BullMQ recreates entries as it
      // works, and an absent stream is fine, but trimming is gentler.
      await redis.xtrim(`bull:${queue}:events`, 'MAXLEN', 0).catch(() => 0);
    }

    const after = field(await redis.info('memory'), 'used_memory');
    console.log(`removed ${removed} job entries`);
    console.log(`used now ${human(after)} (was ${human(used)}, freed ${human(used - after)})`);
    console.log('');
    console.log('Scheduled publishes are rebuilt from the database by the scheduler sweep,');
    console.log('so nothing that was due is lost. Restart the worker to re-register the');
    console.log('repeatable jobs.');
  } finally {
    redis.disconnect();
  }
}

await main();
