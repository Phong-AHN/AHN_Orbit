import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, type TenantContext } from '@orbit/core';
import type * as Core from '@orbit/core';

const enqueue = vi.fn();
const takeToken = vi.fn();
const assertCan = vi.fn();
const canSomewhere = vi.fn();
const socialAccounts = vi.fn();
const postVariants = vi.fn();

vi.mock('@orbit/queue', () => ({ enqueue, takeToken }));
vi.mock('@orbit/rbac', () => ({ assertCan, canSomewhere }));
vi.mock('@orbit/observability', () => ({ logger: { info: vi.fn() } }));
vi.mock('@/server/providers', () => ({ ensureProvidersRegistered: vi.fn() }));
vi.mock('@orbit/providers', () => ({
  // TikTok reports no account-level figures in this fake, as in the product.
  capabilitiesFor: (platform: string) => ({ analytics: { account: platform !== 'TIKTOK' } }),
}));
vi.mock('@orbit/db', () => ({
  withTenant: (_ctx: unknown, fn: (db: unknown) => unknown) =>
    fn({
      socialAccount: { findMany: socialAccounts },
      postVariant: { findMany: postVariants },
    }),
}));
vi.mock('@orbit/core', async (importOriginal) => ({
  ...(await importOriginal<typeof Core>()),
  accessibleWorkspaceIds: () => ['ws-1'],
}));

const { refreshAnalyticsNow } = await import('./refresh');

const ctx = { organizationId: 'org-1' } as unknown as TenantContext;

describe('refreshAnalyticsNow (D-122)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canSomewhere.mockReturnValue(true);
    takeToken.mockResolvedValue({ allowed: true, retryAfterMs: 0 });
    socialAccounts.mockResolvedValue([
      { id: 'acc-fb', platform: 'FACEBOOK', accountType: 'PAGE' },
      { id: 'acc-tt', platform: 'TIKTOK', accountType: null },
    ]);
    postVariants.mockResolvedValue([{ id: 'var-1', socialAccountId: 'acc-fb' }]);
  });

  it('queues the Page read and each post read, and calls no provider itself', async () => {
    const queued = await refreshAnalyticsNow(ctx, {}, 'corr-1');

    expect(queued).toEqual({ accounts: 1, posts: 1 });
    expect(enqueue).toHaveBeenCalledWith(
      'analytics',
      { organizationId: 'org-1', correlationId: 'corr-1', socialAccountId: 'acc-fb' },
      expect.objectContaining({ jobId: expect.stringContaining('acc-fb') as unknown }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      'analytics',
      expect.objectContaining({ socialAccountId: 'acc-fb', postVariantId: 'var-1' }),
      expect.anything(),
    );
    // No account-level job for a platform that reports no account figures.
    expect(enqueue).not.toHaveBeenCalledWith(
      'analytics',
      expect.objectContaining({ socialAccountId: 'acc-tt' }),
      expect.anything(),
    );
  });

  it('only reads what the caller can reach', async () => {
    await refreshAnalyticsNow(ctx, { socialAccountId: 'acc-fb' }, 'corr-1');

    const where = socialAccounts.mock.calls[0]![0].where as Record<string, unknown>;
    expect(where).toMatchObject({ workspaceId: { in: ['ws-1'] }, id: 'acc-fb', status: 'ACTIVE' });
  });

  it('refuses a second press inside the cooldown, queueing nothing', async () => {
    takeToken.mockResolvedValue({ allowed: false, retryAfterMs: 4 * 60 * 1_000 });

    await expect(refreshAnalyticsNow(ctx, {}, 'corr-1')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      userMessage: expect.stringMatching(/Try again in 4 min/) as unknown,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('refuses someone who may not generate reports, before spending anything', async () => {
    canSomewhere.mockReturnValue(false);
    assertCan.mockImplementation(() => {
      throw new ForbiddenError('denied');
    });

    await expect(refreshAnalyticsNow(ctx, {}, 'corr-1')).rejects.toBeInstanceOf(ForbiddenError);
    expect(takeToken).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
