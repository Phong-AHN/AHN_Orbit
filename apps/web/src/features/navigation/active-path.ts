/**
 * Which navigation destination the current URL belongs to.
 *
 * Split out of the nav component so it can be unit tested — the root Vitest
 * config does not resolve the `@/` alias, so anything importable from a test
 * has to be free of them, and this file has no imports at all.
 *
 * It is also the one piece of navigation with a right and a wrong answer. The
 * rest of a sidebar is presentation; "where am I" is a claim, and marking the
 * wrong item is worse than marking none — it tells somebody they are somewhere
 * they are not.
 */

export interface MatchableItem {
  href: string;
  /** Match the href exactly instead of as a prefix. */
  exact?: boolean | undefined;
}

/**
 * The best destination for a path: the longest matching prefix.
 *
 * Longest wins because the destinations genuinely nest.
 * `/orgs/x/settings/accounts` must mark **Accounts** and not **Clients**, even
 * though both sit under `/settings` and both match — the more specific href is
 * the one the person actually chose.
 *
 * `exact` exists for destinations that are a parent of everything below them.
 * The agency's "Today" lives at the organization root, so as a prefix it would
 * match every page in the product and mark itself active on all of them.
 *
 * Matching is on **path segments**, not characters: `/posts` must not match
 * `/posts-archive`, which a bare `startsWith` would.
 */
export function bestMatch(
  pathname: string,
  items: readonly MatchableItem[],
): string | undefined {
  let best: string | undefined;

  for (const item of items) {
    const matches = item.exact
      ? pathname === item.href
      : pathname === item.href || pathname.startsWith(`${item.href}/`);

    if (matches && (best === undefined || item.href.length > best.length)) {
      best = item.href;
    }
  }

  return best;
}
