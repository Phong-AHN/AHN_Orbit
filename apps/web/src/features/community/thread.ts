/**
 * How a post's comments become a thread, and how a set of comments becomes a
 * list of posts.
 *
 * Pure and tested, so the screens built on it are chrome. That split matters
 * more than usual here: nobody has looked at these pages in a browser, and the
 * decisions most likely to be wrong — what counts as needing a reply, where a
 * reply hangs, what happens to one whose parent is missing — are the ones a
 * test can actually prove.
 */

/** The fields a thread needs. Structural, so it accepts the service's rows. */
export interface ThreadComment {
  id: string;
  externalId: string;
  parentExternalId: string | null;
  origin: 'AUDIENCE' | 'ORBIT';
  state: 'NEW' | 'HANDLED';
  postedAt: Date | string;
}

export interface ThreadNode<C extends ThreadComment> {
  comment: C;
  replies: C[];
}

function time(value: Date | string): number {
  return typeof value === 'string' ? Date.parse(value) : value.getTime();
}

/**
 * Top-level comments, each with its replies beneath it — the shape both
 * platforms draw.
 *
 * ## One level, on purpose
 *
 * Instagram threads exactly one level deep, and re-parents a reply aimed at a
 * reply onto the top-level comment (**D-103**). Facebook allows deeper nesting
 * but draws it flat after the first level in most surfaces. Rendering one level
 * here is therefore faithful to both, and a reply to a reply is placed under
 * the top-level comment it ultimately belongs to.
 *
 * ## A reply whose parent is not here is promoted, never dropped
 *
 * The parent can be missing for ordinary reasons: deleted on the platform,
 * older than the ingestion horizon, or simply re-parented by Instagram before
 * ingestion caught up. Dropping such a reply would hide the agency's own
 * answer from the conversation it answered — so it is shown at top level,
 * which is wrong about *where* and right about *that it exists*.
 *
 * ## Order
 *
 * Top-level oldest first, like both platforms' default thread view, so a
 * conversation reads in the order it happened. Replies oldest first beneath.
 */
export function buildThread<C extends ThreadComment>(comments: readonly C[]): ThreadNode<C>[] {
  const byExternal = new Map<string, C>();
  for (const comment of comments) byExternal.set(comment.externalId, comment);

  /** Walk up to the top-level ancestor, bounded so a cycle cannot spin. */
  function rootOf(comment: C): C | undefined {
    let current: C | undefined = comment;
    for (let hops = 0; current?.parentExternalId && hops < 8; hops += 1) {
      const parent = byExternal.get(current.parentExternalId);
      if (!parent) return undefined;
      current = parent;
    }
    return current?.parentExternalId ? undefined : current;
  }

  const nodes = new Map<string, ThreadNode<C>>();
  const order: ThreadNode<C>[] = [];

  const nodeFor = (comment: C): ThreadNode<C> => {
    let node = nodes.get(comment.externalId);
    if (!node) {
      node = { comment, replies: [] };
      nodes.set(comment.externalId, node);
      order.push(node);
    }
    return node;
  };

  // Top-level first, so a reply always finds its parent's node already built.
  for (const comment of comments) if (!comment.parentExternalId) nodeFor(comment);

  for (const comment of comments) {
    if (!comment.parentExternalId) continue;

    const root = rootOf(comment);
    if (root && root.externalId !== comment.externalId) {
      nodeFor(root).replies.push(comment);
    } else {
      // Orphaned: promoted rather than lost.
      nodeFor(comment);
    }
  }

  order.sort((a, b) => time(a.comment.postedAt) - time(b.comment.postedAt));
  for (const node of order) node.replies.sort((a, b) => time(a.postedAt) - time(b.postedAt));

  return order;
}

/**
 * Whether the audience is still waiting on this comment.
 *
 * Only the audience's comments can be waiting — the agency's own reply is never
 * work — and only while nobody has marked them handled. A reply existing does
 * not by itself count: an answer that does not address the question is not an
 * answer, and the person who decides that is the person who read it.
 */
export function needsReply(comment: Pick<ThreadComment, 'origin' | 'state'>): boolean {
  return comment.origin === 'AUDIENCE' && comment.state === 'NEW';
}

export interface PostSummary {
  /** Comments from the audience, excluding the agency's own replies. */
  audience: number;
  needsReply: number;
  /** The most recent audience comment, for ordering a list by activity. */
  latestAudienceAt: number | null;
}

/**
 * The counts a post card shows, from its comments.
 *
 * `audience` excludes the agency's own replies on purpose. A post with three
 * questions and three answers has three comments worth counting, not six — the
 * number on the card is "how much did people say", and our replies are not
 * what people said.
 */
export function summarizePost(comments: readonly ThreadComment[]): PostSummary {
  let audience = 0;
  let waiting = 0;
  let latest: number | null = null;

  for (const comment of comments) {
    if (comment.origin !== 'AUDIENCE') continue;
    audience += 1;
    if (needsReply(comment)) waiting += 1;

    const at = time(comment.postedAt);
    if (latest === null || at > latest) latest = at;
  }

  return { audience, needsReply: waiting, latestAudienceAt: latest };
}

/**
 * Posts with something waiting first, then by most recent audience activity.
 *
 * A queue is a list of things somebody has to do. Sorting purely by recency
 * would bury a three-day-old unanswered question beneath an hour-old post that
 * everyone has already dealt with.
 */
export function comparePosts(a: PostSummary, b: PostSummary): number {
  const aWaiting = a.needsReply > 0 ? 1 : 0;
  const bWaiting = b.needsReply > 0 ? 1 : 0;
  if (aWaiting !== bWaiting) return bWaiting - aWaiting;

  return (b.latestAudienceAt ?? 0) - (a.latestAudienceAt ?? 0);
}

/**
 * Which platform's comment layout to draw.
 *
 * The two differ in a way people notice immediately and use to orient
 * themselves: Instagram sets the username inline before the text with no
 * container, Facebook puts the name and text together inside a rounded bubble
 * beside the avatar. Anything else gets a neutral layout rather than a guess
 * at a platform it is not.
 */
export type ThreadStyle = 'INSTAGRAM' | 'FACEBOOK' | 'GENERIC';

export function threadStyle(platform: string): ThreadStyle {
  if (platform === 'INSTAGRAM') return 'INSTAGRAM';
  if (platform === 'FACEBOOK') return 'FACEBOOK';
  return 'GENERIC';
}

/**
 * "3h", "2d", "Oct 4" — the compact form both platforms use under a comment.
 *
 * Takes `now` rather than reading a clock, so it is testable and so the server
 * render and the hydrated client cannot disagree by a second and flicker.
 */
export function compactAge(at: Date | string, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - time(at)) / 1_000));

  if (seconds < 60) return 'now';
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d`;

  const date = new Date(time(at));
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${month} ${date.getUTCDate()}`;
}

/** One row of a `groupBy(['postVariantId', 'origin', 'state'])`. */
export interface CommentGroup {
  postVariantId: string;
  origin: 'AUDIENCE' | 'ORBIT';
  state: 'NEW' | 'HANDLED';
  count: number;
  latestAt: Date | null;
}

/**
 * The same summary `summarizePost` produces, built from grouped counts.
 *
 * The list page needs a count per post across every comment an organization
 * has, and fetching each row to count it would grow without bound. A grouped
 * query returns at most four rows per post. This exists so that query cannot
 * drift from the definition above: the test asserts the two agree on the same
 * data, so "needs a reply" means one thing whichever path produced it.
 */
export function summariesFromGroups(groups: readonly CommentGroup[]): Map<string, PostSummary> {
  const out = new Map<string, PostSummary>();

  for (const group of groups) {
    const summary = out.get(group.postVariantId) ?? {
      audience: 0,
      needsReply: 0,
      latestAudienceAt: null,
    };

    if (group.origin === 'AUDIENCE') {
      summary.audience += group.count;
      if (needsReply(group)) summary.needsReply += group.count;

      const at = group.latestAt ? group.latestAt.getTime() : null;
      if (at !== null && (summary.latestAudienceAt === null || at > summary.latestAudienceAt)) {
        summary.latestAudienceAt = at;
      }
    }

    out.set(group.postVariantId, summary);
  }

  return out;
}
