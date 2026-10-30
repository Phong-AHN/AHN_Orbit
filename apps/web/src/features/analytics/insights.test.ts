import { describe, expect, it } from 'vitest';
import { MIN_POSTS_FOR_TIMES, bestPostingTimes, engagementOf, type TimedPost } from './insights';

describe('engagementOf', () => {
  it('sums interactions and leaves distribution out', () => {
    expect(
      engagementOf({
        metrics: { post_reactions: 10, post_comments: 2, post_media_view: 900 },
        availability: { post_reactions: 'AVAILABLE', post_comments: 'AVAILABLE' },
      }),
    ).toBe(12);
  });

  it('is null, not zero, when no interaction was reported', () => {
    expect(engagementOf(null)).toBeNull();
    expect(engagementOf({ metrics: { views: 50 }, availability: {} })).toBeNull();
    expect(
      engagementOf({ metrics: { likes: 0 }, availability: { likes: 'PERMISSION_MISSING' } }),
    ).toBeNull();
  });

  it('counts a real zero as zero', () => {
    expect(engagementOf({ metrics: { likes: 0 }, availability: { likes: 'AVAILABLE' } })).toBe(0);
  });
});

describe('bestPostingTimes', () => {
  const post = (iso: string, engagement: number | null, accountId = 'a1'): TimedPost => ({
    accountId,
    accountName: 'AHN',
    platform: 'FACEBOOK',
    publishedAt: new Date(iso),
    engagement,
  });

  it('refuses to recommend from too few measured posts', () => {
    const few = Array.from({ length: MIN_POSTS_FOR_TIMES - 1 }, (_, i) =>
      post(`2026-10-${String(i + 1).padStart(2, '0')}T12:00:00Z`, 10),
    );
    const [result] = bestPostingTimes([...few, post('2026-10-20T12:00:00Z', null)], 'UTC');
    expect(result).toMatchObject({
      status: 'NOT_ENOUGH_DATA',
      basedOnPosts: MIN_POSTS_FOR_TIMES - 1,
    });
  });

  it('ranks slots by average engagement in the given time zone', () => {
    // Tuesdays 12:00 UTC (19:00 in Ho Chi Minh City) do well; Fridays 02:00 UTC do not.
    const tuesdays = [
      '2026-09-01',
      '2026-09-08',
      '2026-09-15',
      '2026-09-22',
      '2026-09-29',
      '2026-10-06',
      '2026-10-13',
      '2026-10-20',
    ].map((d) => post(`${d}T12:00:00Z`, 100));
    const fridays = [
      '2026-09-04',
      '2026-09-11',
      '2026-09-18',
      '2026-09-25',
      '2026-10-02',
      '2026-10-09',
      '2026-10-16',
      '2026-10-23',
    ].map((d) => post(`${d}T02:00:00Z`, 10));
    const [result] = bestPostingTimes([...tuesdays, ...fridays], 'Asia/Ho_Chi_Minh');
    expect(result!.status).toBe('RECOMMENDED');
    if (result!.status !== 'RECOMMENDED') return;
    expect(result!.slots[0]).toEqual({
      weekday: 'Tuesday',
      hour: 19,
      averageEngagement: 100,
      posts: 8,
    });
    expect(result!.slots[1]).toMatchObject({ weekday: 'Friday', hour: 9 });
  });
});
