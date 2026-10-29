/**
 * Who holds the connections to a Redis (2026-10-27). Read-only.
 *
 *   REDIS_URL="redis://…" node --experimental-strip-types packages/queue/scripts/redis-clients.ts
 *
 * Groups `CLIENT LIST` by source address and connection name. BullMQ names its
 * blocking connections `bull:<base64 queue name>`, decoded here, so Orbit's
 * worker, the web app and anything else sharing the instance can be told
 * apart. A hosted plan's client limit counts all of them together.
 */
import { Redis } from 'ioredis';

const url = process.env.REDIS_URL;
if (!url) {
  console.error('Set REDIS_URL for the Redis to inspect.');
  process.exit(1);
}

const redis = new Redis(url, { maxRetriesPerRequest: 1, connectionName: 'orbit:redis-clients' });

function decodeName(name: string): string {
  const match = /^bull:([A-Za-z0-9+/=]+)(.*)$/.exec(name);
  if (!match) return name || '(unnamed)';
  try {
    return `bull worker: ${Buffer.from(match[1] as string, 'base64').toString('utf8')}${match[2]}`;
  } catch {
    return name;
  }
}

const list = (await redis.client('LIST')) as string;
const clients = list
  .trim()
  .split('\n')
  .map((line) =>
    Object.fromEntries(line.split(' ').map((pair) => pair.split('=') as [string, string])),
  );

const byHost = new Map<string, Map<string, number>>();
for (const client of clients) {
  const host = (client['addr'] ?? '?').replace(/:\d+$/, '');
  const names = byHost.get(host) ?? new Map<string, number>();
  const name = decodeName(client['name'] ?? '');
  names.set(name, (names.get(name) ?? 0) + 1);
  byHost.set(host, names);
}

console.log(`${clients.length} connections (this script's own included)`);
for (const [host, names] of [...byHost].sort((a, b) => sum(b[1]) - sum(a[1]))) {
  console.log(`\n${host}  — ${sum(names)}`);
  for (const [name, count] of [...names].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}  ${name}`);
  }
}
await redis.quit();

function sum(names: Map<string, number>): number {
  return [...names.values()].reduce((total, count) => total + count, 0);
}
