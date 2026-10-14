/**
 * Where a signed-in person belongs.
 *
 * Three surfaces exist and a person's role decides which is theirs. Until now
 * nothing computed that: sign-in sent everybody to the organization picker,
 * which forwards anyone with exactly one organization into
 * `/orgs/{slug}/dashboard` — **including a client**, whose whole product is the
 * portal. See `resolveHome` for what replaces it.
 *
 * Pure and free of `@/` imports so it can be unit tested; the root Vitest
 * config does not resolve that alias. The facts are gathered in
 * `src/server/home.ts`, which is where the database and the cookie live.
 */

/**
 * Which door somebody came through.
 *
 * Each surface has its own sign-in page, so the entrance is a statement of
 * intent — and intent is all it is. **The role decides, the entrance only
 * breaks ties.** Refusing somebody at the wrong door would do two bad things:
 * lock out anyone who bookmarked the wrong page, and turn the three entrances
 * into an oracle that tells an attacker which kind of account an address is.
 */
export type Entrance = 'agency' | 'portal' | 'ops';

export interface HomeFacts {
  /** Organizations this person is *staff* of — any role except CLIENT. */
  agency: ReadonlyArray<{ slug: string }>;
  /** Workspaces this person is a client of. */
  portal: ReadonlyArray<{ id: string }>;
  isPlatformAdmin: boolean;
}

export interface Home {
  surface: 'agency' | 'portal' | 'ops' | 'none';
  /** Null only for `none`: signed in, with nothing they may open. */
  path: string | null;
}

/**
 * Resolve the home surface and path.
 *
 * ## The order, and why operations is not first
 *
 * Staff membership wins, then a client workspace, then operations. Platform
 * operations is checked *last* despite being the most privileged, because it is
 * a tool somebody goes to deliberately rather than a place they live — an AHN
 * engineer who also owns an agency organization should open the product, not
 * the dead-letter queue. They reach operations through its own entrance, which
 * is exactly what `entrance: 'ops'` is for.
 *
 * Someone who is staff in one organization and a client in another lands in the
 * agency surface. There is no good general answer to that — it is a rare shape
 * and both are defensible — so it resolves to the one where they have more to
 * do, and the portal stays reachable by its own entrance and its own link.
 *
 * ## A single destination skips the picker; several do not
 *
 * One organization means the picker would be a page with one button on it. More
 * than one is a real question, and guessing wrong puts somebody in the wrong
 * client's data — so they choose.
 */
export function resolveHome(facts: HomeFacts, entrance?: Entrance): Home {
  // Asked for operations, and entitled to it. The only case where the entrance
  // outranks the role, and it still cannot *grant* anything — the surface's own
  // gate runs again on arrival.
  if (entrance === 'ops' && facts.isPlatformAdmin) {
    return { surface: 'ops', path: '/admin' };
  }

  // Asked for the portal, and a client somewhere. Honoured ahead of staff
  // membership so somebody who holds both can actually reach their portal by
  // signing in at its door.
  if (entrance === 'portal' && facts.portal.length > 0) {
    return { surface: 'portal', path: portalPath(facts.portal) };
  }

  if (facts.agency.length > 0) {
    return { surface: 'agency', path: agencyPath(facts.agency) };
  }

  if (facts.portal.length > 0) {
    return { surface: 'portal', path: portalPath(facts.portal) };
  }

  if (facts.isPlatformAdmin) {
    return { surface: 'ops', path: '/admin' };
  }

  // Authenticated and entitled to nothing: an invitation not yet accepted, or
  // a membership revoked while they were signed in. Not an error — and not a
  // redirect either, or it would bounce between surfaces.
  return { surface: 'none', path: null };
}

function agencyPath(organizations: ReadonlyArray<{ slug: string }>): string {
  const only = organizations.length === 1 ? organizations[0] : undefined;
  return only ? `/orgs/${only.slug}/dashboard` : '/orgs';
}

function portalPath(workspaces: ReadonlyArray<{ id: string }>): string {
  const only = workspaces.length === 1 ? workspaces[0] : undefined;
  return only ? `/portal/${only.id}` : '/portal';
}

/**
 * Whether a `next` parameter may be followed.
 *
 * Sign-in carries `next` so that following a link to a specific post lands on
 * that post rather than a dashboard. Two things it must not become:
 *
 * - **An open redirect.** Only same-site paths, so `//evil.example` and
 *   `https://evil.example` are both refused — the first is a protocol-relative
 *   URL that browsers treat as another origin.
 * - **A way back into the sign-in flow**, which would loop. That covers all
 *   three entrances — `/sign-in`, `/sign-in/client`, `/sign-in/ops` — and
 *   `/continue`, whose whole job is to redirect somewhere else.
 *
 * Returning `null` means "ignore it and use the resolved home", never an error:
 * a malformed `next` is almost always a stale link, not an attack.
 */
export function safeNext(next: string | null | undefined): string | null {
  if (!next) return null;

  // Only same-site paths. `//evil.example` is a protocol-relative URL that
  // browsers treat as another origin, which a bare `startsWith('/')` admits.
  if (!next.startsWith('/')) return null;
  if (next.startsWith('//')) return null;

  // Anchored and segment-aware, so a real page called `/sign-in-help` is not
  // mistaken for the entrance it shares a prefix with.
  if (/^\/(sign-in|continue)(\/|\?|#|$)/.test(next)) return null;

  return next;
}

/**
 * The URL a sign-in form navigates to once the cookie is minted.
 *
 * `/continue` resolves the home surface on the server and redirects. The browser
 * deliberately does not decide: working out where somebody belongs means
 * reading memberships, and a client that guessed would be a second
 * implementation of the surface-separation rules — in the one place that cannot
 * be trusted with them.
 *
 * Both sign-in forms call this, which is also how the open-redirect guard
 * stopped being copy-pasted into each of them.
 */
export function continuePath(entrance: Entrance, next?: string | null | undefined): string {
  const params = new URLSearchParams({ entrance });

  const safe = safeNext(next);
  if (safe) params.set('next', safe);

  return `/continue?${params.toString()}`;
}
