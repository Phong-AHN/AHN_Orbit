import { logger } from '@orbit/observability';
import { redis } from './connection.js';

/**
 * Per-account provider rate limiting (docs/ARCHITECTURE.md §5.3).
 *
 * A token bucket per `(platform, accountId)` in Redis, refilled continuously
 * rather than in fixed windows — a fixed window lets a caller spend the whole
 * budget at the boundary and again immediately after, which is exactly the
 * burst a provider counts against us.
 *
 * The bucket is **adaptive**. Meta reports usage as a percentage in
 * `X-App-Usage` / `X-Business-Use-Case-Usage`, and those figures move; static
 * constants would either throttle us pointlessly or not at all. The adapter
 * parses its own headers — that parsing stays in the Facebook adapter, this
 * layer only stores the number it is told (SRS §8: no platform specifics here).
 *
 * Refill and take are one Lua script so the read-modify-write cannot interleave
 * between workers.
 */

const TAKE_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local bucket = redis.call("hmget", key, "tokens", "updatedAt")
local tokens = tonumber(bucket[1])
local updatedAt = tonumber(bucket[2])

if tokens == nil or updatedAt == nil then
  tokens = capacity
  updatedAt = now
end

-- Continuous refill, capped at capacity.
local elapsed = math.max(now - updatedAt, 0)
tokens = math.min(capacity, tokens + elapsed * refillPerMs)

if tokens < cost then
  -- How long until enough tokens exist, so the caller can back off exactly.
  local deficit = cost - tokens
  local waitMs = math.ceil(deficit / refillPerMs)
  redis.call("hmset", key, "tokens", tokens, "updatedAt", now)
  redis.call("pexpire", key, ttl)
  return {0, waitMs}
end

tokens = tokens - cost
redis.call("hmset", key, "tokens", tokens, "updatedAt", now)
redis.call("pexpire", key, ttl)
return {1, 0}
`;

export interface BucketConfig {
  /** Maximum burst. */
  capacity: number;
  /** How long a full bucket takes to refill from empty. */
  refillWindowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** When refused, how long until the request would succeed. */
  retryAfterMs: number;
}

export function rateLimitKey(platform: string, accountId: string): string {
  return `ratelimit:${platform.toLowerCase()}:${accountId}`;
}

/**
 * The bucket for health probes — deliberately **not** the publishing bucket
 * (decision D-031).
 *
 * Both spend the same provider quota, so sharing one bucket is defensible in
 * theory. In practice it fails in the worst possible direction: the hourly
 * health sweep touches every connected account at once, whereas publishing is
 * bursty and has a deadline. A sweep that drained the shared bucket would defer
 * real publishes at exactly the moment it ran, and the symptom — posts going out
 * late, on the hour — would look nothing like its cause.
 *
 * Separate keys mean a health sweep can only ever starve health probes, which
 * are retried an hour later and cost nothing. The provider's true ceiling is
 * still respected because the adapter narrows *both* buckets from the usage
 * headers it parses on every call.
 */
export function healthRateLimitKey(platform: string, accountId: string): string {
  return `ratelimit:health:${platform.toLowerCase()}:${accountId}`;
}

/**
 * Take a token, or be told how long to wait.
 *
 * Never blocks and never throws on refusal — the caller decides whether to
 * reschedule the job or fail it, because only the caller knows how urgent the
 * work is.
 */
export async function takeToken(
  key: string,
  config: BucketConfig,
  cost = 1,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const refillPerMs = config.capacity / config.refillWindowMs;
  // Idle buckets expire rather than accumulating one key per account forever.
  const ttlMs = Math.max(config.refillWindowMs * 2, 60_000);

  const [allowed, waitMs] = (await redis().eval(
    TAKE_SCRIPT,
    1,
    key,
    String(config.capacity),
    String(refillPerMs),
    String(now),
    String(cost),
    String(Math.ceil(ttlMs)),
  )) as [number, number];

  return { allowed: allowed === 1, retryAfterMs: waitMs };
}

/**
 * Narrow a bucket in response to what the provider reported.
 *
 * `usageRatio` is 0–1, from whatever the adapter parsed out of its own
 * response headers. As usage climbs the effective capacity shrinks, so we slow
 * down before being throttled rather than after. It only ever *reduces* the
 * available tokens; refill restores them naturally.
 */
export async function applyProviderUsage(
  key: string,
  usageRatio: number,
  config: BucketConfig,
  now: number = Date.now(),
): Promise<void> {
  const clamped = Math.min(Math.max(usageRatio, 0), 1);

  // Below 50% reported usage there is nothing to correct for.
  if (clamped < 0.5) return;

  // Linear from full at 50% down to a trickle at 100%.
  const allowedFraction = Math.max(0, (1 - clamped) * 2);
  const ceiling = Math.floor(config.capacity * allowedFraction);

  const connection = redis();
  const current = Number((await connection.hget(key, 'tokens')) ?? config.capacity);

  if (current <= ceiling) return;

  await connection.hmset(key, 'tokens', ceiling, 'updatedAt', now);

  logger.warn('provider usage high; narrowing the rate limit bucket', {
    key,
    usageRatio: clamped,
    tokensBefore: current,
    tokensAfter: ceiling,
  });
}

/** Inspect a bucket. For metrics and tests; not part of the take path. */
export async function bucketState(
  key: string,
): Promise<{ tokens: number; updatedAt: number } | null> {
  const bucket = await redis().hgetall(key);
  if (!bucket.tokens || !bucket.updatedAt) return null;
  return { tokens: Number(bucket.tokens), updatedAt: Number(bucket.updatedAt) };
}
