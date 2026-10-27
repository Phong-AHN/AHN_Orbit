/**
 * Free a full queue Redis without losing anything that matters (2026-10-27).
 *
 *   REDIS_URL="rediss://…" node --experimental-strip-types packages/queue/scripts/redis-trim.ts
 *
 * Add `--dry-run` to only report.
 *
 * For each queue it:
 *   - sets the event stream's length to EVENTS_MAX_LEN and trims it — nothing
 *     reads those events;
 *   - removes completed jobs — a debugging trail, nothing more;
 *   - removes failed jobs older than an hour — the dead-letter view reads
 *     its own store (`dlq:*`), not these;
 *   - says *why* jobs failed, grouped, so a task failing on every run is seen.
 *   - lists every repeating schedule, and removes those whose payload the
 *     queue's schema refuses — another application's, sharing this Redis.
 *
 * And the dead-letter store: keeps the newest MAX_DEAD_LETTERS, and deletes
 * entries no longer in its index.
 *
 * It does **not** touch waiting, delayed or active jobs, or the repeatable
 * schedules. Scheduled posts are safe either way:
 * the database is their source of truth and the 30-second sweep re-enqueues
 * anything due.
 *
 * Reads REDIS_URL from the environment only, never from `.env`, so it cannot
 * be pointed at production by accident.
 */
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_DEFINITIONS, QUEUE_NAMES } from '../dist/queues.js';
import { EVENTS_MAX_LEN } from '../dist/producer.js';
import { MAX_DEAD_LETTERS } from '../dist/dead-letter.js';

const url = process.env.REDIS_URL;
if (!url) {
  console.error('Set REDIS_URL for the Redis to trim.');
  process.exit(1);
}
const dryRun = process.argv.includes('--dry-run');
const ONE_HOUR_MS = 3_600 * 1_000;

const redis = new Redis(url, { maxRetriesPerRequest: null });

async function memory(): Promise<string> {
  const info = await redis.info('memory');
  const read = (key: string) => new RegExp(`^${key}:(.*)$`, 'm').exec(info)?.[1]?.trim() ?? '?';
  return `used ${read('used_memory_human')} of ${read('maxmemory_human')} (policy ${read('maxmemory_policy')})`;
}

/** The biggest key families, by sampled MEMORY USAGE — to say what filled it. */
async function topFamilies(limit = 2_000): Promise<Array<[string, number]>> {
  const totals = new Map<string, number>();
  let cursor = '0';
  let seen = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'COUNT', 200);
    cursor = next;
    if (keys.length === 0) continue;

    // One round trip per batch, not per key: a hosted Redis is a network hop
    // away, and two thousand sequential calls took minutes.
    const pipeline = redis.pipeline();
    for (const key of keys) pipeline.memory('USAGE', key);
    const sizes = (await pipeline.exec()) ?? [];

    keys.forEach((key, index) => {
      const bytes = Number(sizes[index]?.[1] ?? 0);
      // bull:<queue>:<id> → bull:<queue>:<id>; numeric and uuid-ish ids collapse.
      const family = key.replace(/:[0-9a-f-]{8,}.*$|:\d+$/i, ':<id>');
      totals.set(family, (totals.get(family) ?? 0) + bytes);
    });
    seen += keys.length;
    process.stdout.write(`\r  scanned ${seen} keys…`);
  } while (cursor !== '0' && seen < limit);
  process.stdout.write('\n');
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
}

console.log(`Before: ${await memory()}`);
console.log('Largest key families (sampled):');
for (const [family, bytes] of await topFamilies()) {
  console.log(`  ${(bytes / 1024).toFixed(0).padStart(8)} KB  ${family}`);
}

// First, plain deletes only. A full Redis under `noeviction` refuses every
// BullMQ script — even `clean`, which writes an event before it removes
// anything — but still accepts DEL, XTRIM and ZREM, which only free memory.

// The dead-letter store: newest MAX_DEAD_LETTERS kept, the rest and any entry
// whose index row is already gone deleted.
const indexed = await redis.zcard('dlq:index');
let orphans = 0;
let cursor = '0';
const keep = new Set(await redis.zrevrange('dlq:index', 0, MAX_DEAD_LETTERS - 1));
const doomed: string[] = [];
do {
  const [next, keys] = await redis.scan(cursor, 'MATCH', 'dlq:entry:*', 'COUNT', 500);
  cursor = next;
  for (const key of keys) {
    if (!keep.has(key.slice('dlq:entry:'.length))) doomed.push(key);
  }
} while (cursor !== '0');
orphans = doomed.length;
console.log(
  `dead letters    indexed ${indexed}  entries to delete ${orphans} (keeping newest ${MAX_DEAD_LETTERS})`,
);
if (!dryRun) {
  for (let i = 0; i < doomed.length; i += 500) await redis.del(...doomed.slice(i, i + 500));
  await redis.zremrangebyrank('dlq:index', 0, -(MAX_DEAD_LETTERS + 1));
}

if (!dryRun) {
  for (const name of QUEUE_NAMES) {
    await redis.xtrim(`bull:${name}:events`, 'MAXLEN', '~', EVENTS_MAX_LEN);
  }
  console.log(`Freed with plain deletes: ${await memory()}`);
}

for (const name of QUEUE_NAMES) {
  const queue = new Queue(name, {
    connection: redis,
    // Opening the queue with this writes the new length into its meta hash,
    // which every BullMQ script reads — the worker's included. A dry run
    // writes nothing, so it skips that too.
    ...(dryRun ? { skipMetasUpdate: true } : { streams: { events: { maxLen: EVENTS_MAX_LEN } } }),
  });

  const events = await redis.xlen(`bull:${name}:events`);
  const counts = await queue.getJobCounts('completed', 'failed', 'waiting', 'delayed', 'active');

  console.log(
    `${name.padEnd(15)} events ${String(events).padStart(6)}  completed ${String(counts.completed).padStart(5)}  failed ${String(counts.failed).padStart(5)}  waiting ${counts.waiting}  delayed ${counts.delayed}  active ${counts.active}`,
  );

  // Why they failed, newest 200, grouped. The reason is the error message,
  // which the worker writes without payloads or tokens.
  if (counts.failed > 0) {
    const reasons = new Map<string, number>();
    for (const job of await queue.getJobs(['failed'], 0, 199)) {
      const task = (job.data as { task?: string } | undefined)?.task;
      const key = `${task ? `[${task}] ` : ''}${(job.failedReason ?? 'no reason').slice(0, 160)}`;
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      console.log(`    ${String(count).padStart(4)} × ${reason}`);
    }
  }

  // Repeating schedules, Orbit's and anybody else's. A schedule whose payload
  // this queue's schema refuses was not registered by Orbit — on 2026-10-27
  // two such (`retry-outbox`, `recompute-health`) fired into `maintenance`
  // every few minutes, failed validation every time, and filled the Redis.
  const schema = QUEUE_DEFINITIONS[name].schema;
  const foreign = new Set<string>();
  const schedulers = await queue.getJobSchedulers(0, -1, true).catch(() => []);
  for (const scheduler of schedulers) {
    const data = scheduler.template?.data;
    const ours = data === undefined ? undefined : schema.safeParse(data).success;
    if (ours === false) foreign.add(scheduler.key);
    const task = (data as { task?: string } | undefined)?.task ?? scheduler.name;
    console.log(
      `    schedule ${ours === false ? 'NOT ORBIT' : 'orbit    '} ${String(scheduler.pattern ?? `every ${scheduler.every}ms`).padEnd(16)} ${task}  (${scheduler.key})`,
    );
  }
  // A schedule stored the older way carries no template; its next job does.
  const pending = await queue.getJobs(['delayed', 'waiting', 'prioritized'], 0, 500);
  const strays = pending.filter((job) => !schema.safeParse(job.data).success);
  for (const job of strays) {
    if (job.repeatJobKey) foreign.add(job.repeatJobKey);
  }
  if (strays.length > 0) {
    const tasks = [
      ...new Set(strays.map((job) => (job.data as { task?: string })?.task ?? job.name)),
    ];
    console.log(`    ${strays.length} pending job(s) Orbit cannot run: ${tasks.join(', ')}`);
  }

  if (!dryRun) {
    for (const key of foreign) {
      await queue.removeJobScheduler(key).catch(() => false);
      await queue.removeRepeatableByKey(key).catch(() => false);
    }
    for (const job of strays) await job.remove().catch(() => undefined);
    if (foreign.size > 0) console.log(`    removed ${foreign.size} foreign schedule(s)`);

    await queue.trimEvents(EVENTS_MAX_LEN);
    await queue.clean(0, 100_000, 'completed');
    await queue.clean(ONE_HOUR_MS, 100_000, 'failed');
  }

  await queue.close();
}

console.log(`${dryRun ? 'Dry run — nothing removed. ' : ''}After: ${await memory()}`);
await redis.quit();
