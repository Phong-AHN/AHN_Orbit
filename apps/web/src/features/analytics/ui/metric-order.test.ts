import { describe, expect, it } from 'vitest';
import { orderMetrics } from './metric-label';

/**
 * Which four numbers a client sees first (**D-074**).
 *
 * Previously whatever order the provider's JSON arrived in, which meant two
 * posts on the same account could lead with different metrics. These assert the
 * product decision rather than the implementation: the platforms differ, and
 * the difference is deliberate.
 */
describe('orderMetrics', () => {
  it('leads a Facebook post with views, then unique, then reactions', () => {
    const ordered = orderMetrics('FACEBOOK', {
      post_clicks: 4,
      post_reactions_by_type_total: 3,
      post_total_media_view_unique: 2,
      post_media_view: 1,
    });

    expect(ordered.map(([name]) => name)).toEqual([
      'post_media_view',
      'post_total_media_view_unique',
      'post_reactions_by_type_total',
      'post_clicks',
    ]);
  });

  /**
   * Not the same list. Instagram is an engagement medium and `saved` is the
   * strongest signal it gives that a post was worth keeping — a shared order
   * would bury it behind clicks, which Instagram does not even report.
   */
  it('leads an Instagram post with views, reach, likes, saves', () => {
    const ordered = orderMetrics('INSTAGRAM', {
      shares: 5,
      saved: 4,
      likes: 3,
      reach: 2,
      views: 1,
    });

    expect(ordered.slice(0, 4).map(([name]) => name)).toEqual(['views', 'reach', 'likes', 'saved']);
  });

  it('keeps a metric nobody prioritised, behind the ones somebody did', () => {
    const ordered = orderMetrics('INSTAGRAM', { some_new_metric: 9, views: 1 });

    expect(ordered.map(([name]) => name)).toEqual(['views', 'some_new_metric']);
  });

  it('is stable and alphabetical for an unknown platform', () => {
    const ordered = orderMetrics('TIKTOK', { zebra: 1, alpha: 2 });

    expect(ordered.map(([name]) => name)).toEqual(['alpha', 'zebra']);
  });

  it('never drops a metric', () => {
    const metrics = { views: 1, reach: 2, unknown_one: 3, unknown_two: 4 };

    expect(orderMetrics('INSTAGRAM', metrics)).toHaveLength(Object.keys(metrics).length);
  });
});
