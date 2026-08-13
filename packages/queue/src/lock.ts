import { newCorrelationId } from '@orbit/core';
import { logger } from '@orbit/observability';
import { redis } from './connection.js';

/**
 * Advisory locks (docs/ARCHITECTURE.md §5.2 layer 3).
 *
 * Bounds concurrent provider calls per account. It is explicitly **layer 3**,
 * not the guarantee: Redis can lose a lock to a failover, and a lock that
 * expires mid-call is indistinguishable from one that was never held. The real
 * protection against a duplicate publish is layer 2 — the atomic
 * compare-and-set on `PostVariant.status` in Postgres. This layer keeps us
 * polite to the provider and keeps the common case clean.
 *
 * Release is compare-and-delete via Lua, so a slow holder whose lease already
 * expired cannot delete the lock a *different* worker has since taken.
 */

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export interface Lock {
  key: string;
  token: string;
}

/** Take a lock, or return null if someone else holds it. */
export async function acquireLock(key: string, ttlMs: number): Promise<Lock | null> {
  const token = newCorrelationId();
  const result = await redis().set(key, token, 'PX', ttlMs, 'NX');
  return result === 'OK' ? { key, token } : null;
}

/** Give it back. A no-op if the lease already expired and was retaken. */
export async function releaseLock(lock: Lock): Promise<boolean> {
  const released = await redis().eval(RELEASE_SCRIPT, 1, lock.key, lock.token);
  return released === 1;
}

/**
 * Run `fn` while holding a lock, or throw if it cannot be taken.
 *
 * Deliberately does not wait for the lock. A publish job that cannot get its
 * account's lock should go back to the queue with a short backoff rather than
 * hold a worker slot blocking — the slot is more valuable than the immediacy.
 */
export async function withLock<T>(
  key: string,
  ttlMs: number,
  fn: (lock: Lock) => Promise<T>,
): Promise<T | typeof LOCK_UNAVAILABLE> {
  const lock = await acquireLock(key, ttlMs);
  if (!lock) return LOCK_UNAVAILABLE;

  try {
    return await fn(lock);
  } finally {
    const released = await releaseLock(lock).catch(() => false);
    if (!released) {
      // Worth knowing: it means the call outlived its lease, so the TTL is too
      // short for the work and two workers may have overlapped.
      logger.warn('lock lease expired before release', { key });
    }
  }
}

export const LOCK_UNAVAILABLE = Symbol('LOCK_UNAVAILABLE');

/** One publish at a time per connected account. */
export function publishLockKey(socialAccountId: string): string {
  return `lock:publish:${socialAccountId}`;
}
