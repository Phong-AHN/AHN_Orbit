/**
 * Turning a provider metric name into something a person reads.
 *
 * The names are Meta's and they are not English: `post_total_media_view_unique`
 * is "unique views", and putting the raw name in front of a client makes the
 * report look like a database dump. Anything unmapped falls through to a
 * de-underscored version rather than being hidden — a metric added tomorrow
 * appears tomorrow, slightly ugly, instead of silently vanishing from a report.
 */

const LABEL: Record<string, string> = {
  // Facebook Page and post metrics, at v25.0.
  page_media_view: 'Page views',
  post_media_view: 'Views',
  page_total_media_view_unique: 'Unique page views',
  post_total_media_view_unique: 'Unique views',
  page_follows: 'Followers',
  page_follows_city: 'Followers by city',
  page_follows_country: 'Followers by country',
  page_post_engagements: 'Engagements',
  post_reactions_by_type_total: 'Reactions',
  post_clicks: 'Clicks',

  // Instagram. `views` replaced the whole impressions family in v22.0.
  views: 'Views',
  reach: 'Reach',
  likes: 'Likes',
  comments: 'Comments',
  saved: 'Saves',
  saves: 'Saves',
  shares: 'Shares',
  total_interactions: 'Interactions',
  profile_links_taps: 'Link taps',
  accounts_engaged: 'Accounts engaged',
};

export function metricLabel(name: string): string {
  return LABEL[name] ?? name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * Why a number is missing, said plainly.
 *
 * Never "0", and never blank. §18 asks for unavailable metrics to be *clearly
 * indicated*, and the reason matters to an agency explaining a report: a
 * withdrawn metric is Meta's decision and permanent, while an error is ours and
 * temporary.
 */
export function unavailableReason(state: string): string {
  switch (state) {
    case 'DEPRECATED':
      return 'No longer provided by the platform';
    case 'UNSUPPORTED':
      return 'Not offered for this account type';
    case 'ERROR':
      return 'Could not be read on the last check';
    default:
      return 'Not available';
  }
}

/** 1_234_567 → "1.2M". Long numbers in a grid are read as shapes, not values. */
export function compactNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 10_000) return `${(value / 1_000).toFixed(0)}K`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString('en-US');
}

/**
 * Which metrics lead, per platform (**D-074**).
 *
 * The strip used to show the first four the platform happened to return, in
 * whatever order the JSON arrived — so which numbers a client saw first was an
 * accident of iteration order, and it differed between two posts on the same
 * account.
 *
 * These orders are a product decision, not a technical one, and the two
 * platforms genuinely differ:
 *
 * - **Facebook** is a reach-and-response medium for a Page. Views first, then
 *   how many distinct people, then what they did about it.
 * - **Instagram** is an engagement medium. Views still lead — it is the metric
 *   Meta replaced the whole impressions family with — but likes and saves say
 *   more about a post there than clicks do, and `saved` in particular is the
 *   strongest signal Instagram gives that a post was worth keeping.
 *
 * Anything not named falls in behind, alphabetically, so a metric added by the
 * platform tomorrow still appears — just not ahead of the ones chosen on
 * purpose.
 */
const PRIORITY: Record<string, readonly string[]> = {
  FACEBOOK: [
    'post_media_view',
    'post_total_media_view_unique',
    'post_reactions_by_type_total',
    'post_clicks',
    'page_media_view',
    'page_total_media_view_unique',
    'page_follows',
    'page_post_engagements',
  ],
  INSTAGRAM: ['views', 'reach', 'likes', 'saved', 'comments', 'shares', 'total_interactions'],
};

/**
 * Order a metric set for display, most meaningful first.
 *
 * Total, not partial: everything is returned, so a caller that shows all of
 * them gets a sensible order too, and only the strip does the slicing.
 */
export function orderMetrics(
  platform: string,
  metrics: Record<string, number>,
): Array<[string, number]> {
  const priority = PRIORITY[platform.toUpperCase()] ?? [];

  return Object.entries(metrics).sort(([a], [b]) => {
    const rankA = priority.indexOf(a);
    const rankB = priority.indexOf(b);

    // Both chosen: the order above. One chosen: it leads. Neither: alphabetical,
    // which is at least stable between two posts on the same account.
    if (rankA !== -1 && rankB !== -1) return rankA - rankB;
    if (rankA !== -1) return -1;
    if (rankB !== -1) return 1;
    return a.localeCompare(b);
  });
}
