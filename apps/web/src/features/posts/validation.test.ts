import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@orbit/core';
import type * as Providers from '@orbit/providers';
import { validatePost } from './validation';

/**
 * The settings a platform will not publish without block the post on the
 * server, not only in the composer — so it cannot be scheduled, published now
 * or published without review with TikTok's "Who can see this" unanswered.
 */

const fake = vi.hoisted(() => {
  const state = { platformOptions: {} as Record<string, unknown>, platform: 'TIKTOK' };
  const db = {
    post: {
      findFirst: () =>
        Promise.resolve({
          id: 'post-1',
          body: 'A video post',
          scheduledFor: null,
          media: [],
          variants: [
            {
              id: 'variant-1',
              platform: state.platform,
              body: '',
              linkUrl: null,
              hashtags: [],
              firstComment: null,
              platformOptions: state.platformOptions,
              scheduledFor: null,
              socialAccountId: 'account-1',
              socialAccount: {
                displayName: 'AHN',
                accountType: null,
                status: 'ACTIVE',
                scopes: [],
              },
              media: [],
            },
          ],
        }),
    },
  };
  return { state, db };
});

vi.mock('@orbit/db', () => ({
  withTenant: (_ctx: unknown, run: (db: typeof fake.db) => unknown) => run(fake.db),
}));
vi.mock('@/server/providers', () => ({ ensureProvidersRegistered: vi.fn() }));
vi.mock('@orbit/providers', async (importOriginal) => {
  const real = await importOriginal<typeof Providers>();
  const { tiktokCapabilities } = await import('@orbit/providers/tiktok');
  const { blueskyCapabilities } = await import('@orbit/providers/bluesky');
  return {
    ...real,
    capabilitiesFor: (platform: string) =>
      platform === 'TIKTOK' ? tiktokCapabilities('v2') : blueskyCapabilities('1'),
  };
});

const ctx = { organizationId: 'org-1' } as TenantContext;

function settingIssues(result: Awaited<ReturnType<typeof validatePost>>) {
  return result.variants.flatMap((v) =>
    v.result.issues.filter((issue) => issue.code === 'PLATFORM_SETTING_REQUIRED'),
  );
}

beforeEach(() => {
  fake.state.platform = 'TIKTOK';
  fake.state.platformOptions = {};
});

describe('settings a platform requires', () => {
  it('blocks a TikTok post until "Who can see this" is chosen, and says so', async () => {
    const result = await validatePost(ctx, 'post-1');
    const [issue] = settingIssues(result);

    expect(result.valid).toBe(false);
    expect(issue).toMatchObject({
      severity: 'ERROR',
      field: 'platformOptions.privacyLevel',
      meta: { setting: 'privacyLevel' },
    });
    expect(issue?.message).toMatch(/Who can see this/);
    expect(issue?.message).toMatch(/AHN \(TikTok\)/);
  });

  it('lets it through once the choice is saved', async () => {
    fake.state.platformOptions = { privacyLevel: 'SELF_ONLY' };
    expect(settingIssues(await validatePost(ctx, 'post-1'))).toHaveLength(0);
  });

  it('asks for nothing when the video is sent to TikTok to finish there', async () => {
    fake.state.platformOptions = { postMode: 'MEDIA_UPLOAD' };
    expect(settingIssues(await validatePost(ctx, 'post-1'))).toHaveLength(0);
  });

  it('asks nothing of a platform without such settings', async () => {
    fake.state.platform = 'BLUESKY';
    expect(settingIssues(await validatePost(ctx, 'post-1'))).toHaveLength(0);
  });
});
