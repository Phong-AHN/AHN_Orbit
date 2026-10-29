import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitedError, type TenantContext } from '@orbit/core';

const takeToken = vi.fn();
vi.mock('@orbit/queue', () => ({ takeToken: (...args: unknown[]) => takeToken(...args) }));

const { assertAIRateLimit } = await import('./rate-limit');

/**
 * The AI rate limiter when its store is away (2026-10-29).
 *
 * A full Redis refused new clients and every AI request failed with a 500 —
 * the guard on the pace of spend had become an outage of the feature. The
 * amount is capped by the credit check, which reads the database, so the pace
 * guard steps aside when Redis cannot be reached, and still refuses a burst
 * when it can.
 */

const ctx: TenantContext = {
  organizationId: '018f0000-0000-7000-8000-000000000001',
  principal: {
    kind: 'USER',
    userId: '018f0000-0000-7000-8000-000000000002',
    organizationRole: 'OWNER',
  } as TenantContext['principal'],
  correlationId: 'test',
};

beforeEach(() => {
  takeToken.mockReset();
});

describe('assertAIRateLimit', () => {
  it('lets a request through when Redis cannot be reached', async () => {
    takeToken.mockImplementation(async () => {
      throw new Error('ERR max number of clients reached');
    });
    expect(await assertAIRateLimit(ctx)).toBeUndefined();
    // Both buckets were asked, and neither refusal reached the caller.
    expect(takeToken).toHaveBeenCalledTimes(2);
  });

  it('still refuses a burst when Redis answers', async () => {
    takeToken.mockResolvedValue({ allowed: false, retryAfterMs: 5_000 });
    await expect(assertAIRateLimit(ctx)).rejects.toBeInstanceOf(RateLimitedError);
  });
});
