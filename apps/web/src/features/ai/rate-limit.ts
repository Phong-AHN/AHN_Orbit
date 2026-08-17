import { RateLimitedError, isUserPrincipal, type TenantContext } from '@orbit/core';
import { takeToken } from '@orbit/queue';

/**
 * A ceiling on how *fast* AI can be spent, not just how much (T4.3 follow-up).
 *
 * The monthly credit limit stops an organization exceeding its plan. It does
 * nothing about the shape of that spend: a loop — a stuck retry, a script, a
 * double-bound button — can burn a whole month's allowance in seconds, and the
 * first anyone hears of it is a bill and a feature that stopped working.
 *
 * Two buckets, because they answer different questions:
 *
 * - **per user**, so one person's runaway client cannot exhaust the
 *   organization's month;
 * - **per organization**, so a coordinated burst across several users still has
 *   a ceiling.
 *
 * Deliberately generous for a human. Nobody writing captions presses the button
 * ten times in a minute; a program does. The limit is shaped to be invisible to
 * the first and immediate for the second.
 */

/** Ten generations a minute is far above human pace and far below a loop's. */
const PER_USER = { capacity: 10, refillWindowMs: 60_000 };

/** An agency of ten all working at once stays under this. */
const PER_ORGANIZATION = { capacity: 40, refillWindowMs: 60_000 };

export function aiRateLimitKey(scope: 'user' | 'org', id: string): string {
  return `ratelimit:ai:${scope}:${id}`;
}

/**
 * Take a token from both buckets, or refuse.
 *
 * Checked **before** the credit check and before the provider call, so a burst
 * costs neither money nor credits. Refusal is a `RateLimitedError`, which the
 * API envelope already turns into a 429 with `Retry-After`.
 *
 * The organization bucket is taken first: if it refuses, the user's own bucket
 * is left untouched, so one person is not charged a token for a burst somebody
 * else caused.
 */
export async function assertAIRateLimit(ctx: TenantContext): Promise<void> {
  const org = await takeToken(aiRateLimitKey('org', ctx.organizationId), PER_ORGANIZATION);

  if (!org.allowed) {
    throw new RateLimitedError('Organization AI rate limit reached', {
      retryAfterSeconds: Math.ceil(org.retryAfterMs / 1_000),
      userMessage:
        'Your team is generating faster than we allow. Try again in a moment — nothing was charged.',
    });
  }

  if (!isUserPrincipal(ctx.principal)) return;

  const user = await takeToken(aiRateLimitKey('user', ctx.principal.userId), PER_USER);

  if (!user.allowed) {
    throw new RateLimitedError('User AI rate limit reached', {
      retryAfterSeconds: Math.ceil(user.retryAfterMs / 1_000),
      userMessage: 'That is faster than the assistant runs. Try again in a moment.',
    });
  }
}
