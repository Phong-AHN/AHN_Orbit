/**
 * Reading performance without a model (D-109 §8.3): what counts as engagement,
 * and when a brand's posts do best.
 *
 * Pure, so it is testable to the number, and deliberately conservative: a
 * figure the platform did not report is not engagement of zero, and a posting
 * time is only recommended when there are enough posts behind it to mean
 * anything.
 */

/**
 * The metrics that are someone *doing* something with a post, by platform.
 *
 * Views and reach are left out on purpose: they measure distribution, which
 * the platform decides, while these measure response, which the content earns.
 */
export const INTERACTION_METRICS: ReadonlySet<string> = new Set([
  // Facebook
  'post_reactions',
  'post_comments',
  'post_shares',
  // Instagram
  'likes',
  'comments',
  'saved',
  'saves',
  'shares',
  // Pinterest
  'SAVE',
  'PIN_CLICK',
  'OUTBOUND_CLICK',
  // TikTok and YouTube
  'like_count',
  'comment_count',
  'share_count',
  'likeCount',
  'commentCount',
]);

export interface MetricReading {
  metrics: Record<string, number>;
  availability: Record<string, string>;
}

/**
 * Interactions on one post, or `null` when none of its interaction metrics
 * were reported — which is not the same as nobody interacting.
 */
export function engagementOf(reading: MetricReading | null): number | null {
  if (!reading) return null;
  let total = 0;
  let counted = 0;
  for (const [name, value] of Object.entries(reading.metrics)) {
    if (!INTERACTION_METRICS.has(name)) continue;
    const state = reading.availability[name];
    if (state !== undefined && state !== 'AVAILABLE') continue;
    if (!Number.isFinite(value)) continue;
    total += value;
    counted += 1;
  }
  return counted > 0 ? total : null;
}

export interface TimedPost {
  accountId: string;
  accountName: string;
  platform: string;
  publishedAt: Date;
  engagement: number | null;
}

export interface PostingSlot {
  weekday: string;
  hour: number;
  averageEngagement: number;
  posts: number;
}

export type AccountTimes =
  | {
      accountId: string;
      accountName: string;
      platform: string;
      status: 'RECOMMENDED';
      basedOnPosts: number;
      slots: PostingSlot[];
    }
  | {
      accountId: string;
      accountName: string;
      platform: string;
      status: 'NOT_ENOUGH_DATA';
      basedOnPosts: number;
      needed: number;
    };

/** Below this many measured posts an average says more about luck than about timing. */
export const MIN_POSTS_FOR_TIMES = 15;
/** And a slot needs at least two posts of its own to be compared at all. */
const MIN_POSTS_PER_SLOT = 2;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function localSlot(date: Date, timeZone: string): { weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? WEEKDAYS[date.getUTCDay()]!;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? date.getUTCHours());
  return { weekday, hour: hour === 24 ? 0 : hour };
}

/**
 * The best weekday-and-hour slots per account, from its own history.
 *
 * Slots are hours in the given time zone. Only posts with a measured
 * engagement count; an account with fewer than `MIN_POSTS_FOR_TIMES` of them
 * gets an honest "not enough data" instead of a recommendation.
 */
export function bestPostingTimes(
  posts: readonly TimedPost[],
  timeZone: string,
  top = 3,
): AccountTimes[] {
  const byAccount = new Map<string, TimedPost[]>();
  for (const post of posts) {
    const list = byAccount.get(post.accountId) ?? [];
    list.push(post);
    byAccount.set(post.accountId, list);
  }

  return [...byAccount.values()].map((list) => {
    const first = list[0]!;
    const measured = list.filter((p) => p.engagement !== null);
    const base = {
      accountId: first.accountId,
      accountName: first.accountName,
      platform: first.platform,
    };

    if (measured.length < MIN_POSTS_FOR_TIMES) {
      return {
        ...base,
        status: 'NOT_ENOUGH_DATA' as const,
        basedOnPosts: measured.length,
        needed: MIN_POSTS_FOR_TIMES,
      };
    }

    const slots = new Map<string, { weekday: string; hour: number; sum: number; posts: number }>();
    for (const post of measured) {
      const { weekday, hour } = localSlot(post.publishedAt, timeZone);
      const key = `${weekday}:${hour}`;
      const slot = slots.get(key) ?? { weekday, hour, sum: 0, posts: 0 };
      slot.sum += post.engagement!;
      slot.posts += 1;
      slots.set(key, slot);
    }

    const ranked = [...slots.values()]
      .filter((s) => s.posts >= MIN_POSTS_PER_SLOT)
      .map((s) => ({
        weekday: s.weekday,
        hour: s.hour,
        averageEngagement: Math.round(s.sum / s.posts),
        posts: s.posts,
      }))
      .sort((a, b) => b.averageEngagement - a.averageEngagement || b.posts - a.posts)
      .slice(0, top);

    if (ranked.length === 0) {
      return {
        ...base,
        status: 'NOT_ENOUGH_DATA' as const,
        basedOnPosts: measured.length,
        needed: MIN_POSTS_FOR_TIMES,
      };
    }
    return {
      ...base,
      status: 'RECOMMENDED' as const,
      basedOnPosts: measured.length,
      slots: ranked,
    };
  });
}
