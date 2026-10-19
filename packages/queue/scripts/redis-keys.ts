/** Read-only: what key families this Redis holds, so a flush is an informed one. */
import Redis from 'ioredis';

const url = process.env.REDIS_URL;
if (!url) {
  console.error('REDIS_URL is not set.');
  process.exit(1);
}

const redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
redis.on('error', () => {
  /* reported from the connect failure */
});

try {
  await redis.connect().catch((error: unknown) => {
    console.error(`Cannot reach Redis: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });

  const families = new Map<string, number>();
  let cursor = '0';

  do {
    const [next, keys] = await redis.scan(cursor, 'COUNT', 500);
    cursor = next;
    for (const key of keys) {
      const family = key.split(':').slice(0, 2).join(':');
      families.set(family, (families.get(family) ?? 0) + 1);
    }
  } while (cursor !== '0');

  console.log('key families:');
  for (const [family, count] of [...families].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(7)}  ${family}`);
  }
  console.log(`total keys: ${await redis.dbsize()}`);
} finally {
  redis.disconnect();
}
