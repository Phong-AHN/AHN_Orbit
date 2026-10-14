import { describe, expect, it } from 'vitest';

import { bestMatch } from './active-path';

const AGENCY = [
  { href: '/orgs/ahn/dashboard', exact: true },
  { href: '/orgs/ahn/posts' },
  { href: '/orgs/ahn/settings/workspaces' },
  { href: '/orgs/ahn/settings/accounts' },
  { href: '/orgs/ahn/settings/members' },
];

describe('bestMatch', () => {
  it('marks the destination you are on', () => {
    expect(bestMatch('/orgs/ahn/posts', AGENCY)).toBe('/orgs/ahn/posts');
  });

  it('marks the parent destination for a page beneath it', () => {
    expect(bestMatch('/orgs/ahn/posts/018f-abc', AGENCY)).toBe('/orgs/ahn/posts');
    expect(bestMatch('/orgs/ahn/posts/new', AGENCY)).toBe('/orgs/ahn/posts');
  });

  /**
   * Both of these match as prefixes. The longer one is the destination the
   * person actually chose — marking "Clients" while they are on Accounts tells
   * them they are somewhere they are not.
   */
  it('prefers the more specific of two nested destinations', () => {
    expect(bestMatch('/orgs/ahn/settings/accounts', AGENCY)).toBe('/orgs/ahn/settings/accounts');
    expect(bestMatch('/orgs/ahn/settings/accounts/connect', AGENCY)).toBe(
      '/orgs/ahn/settings/accounts',
    );
  });

  /**
   * An `exact` destination at the root of a surface would otherwise match
   * every page in the product and mark itself active on all of them.
   */
  it('does not let an exact destination claim its descendants', () => {
    expect(bestMatch('/orgs/ahn/dashboard', AGENCY)).toBe('/orgs/ahn/dashboard');
    expect(bestMatch('/orgs/ahn/dashboard/anything', AGENCY)).toBeUndefined();
  });

  /** `/posts` is not the parent of `/posts-archive`. */
  it('matches whole segments rather than characters', () => {
    expect(bestMatch('/orgs/ahn/posts-archive', AGENCY)).toBeUndefined();
  });

  it('marks nothing on a page that is not in the navigation', () => {
    expect(bestMatch('/orgs/ahn/billing', AGENCY)).toBeUndefined();
    expect(bestMatch('/sign-in', AGENCY)).toBeUndefined();
  });

  it('marks nothing when there is nothing to match', () => {
    expect(bestMatch('/orgs/ahn/posts', [])).toBeUndefined();
  });

  /**
   * The portal and admin surfaces have no `exact` destination at their root, so
   * their first item is a genuine prefix of the others and must still lose to
   * them.
   */
  it('handles a surface whose root item is a real prefix', () => {
    const portal = [
      { href: '/portal/ws-1' },
      { href: '/portal/ws-1/upcoming' },
      { href: '/portal/ws-1/published' },
    ];

    expect(bestMatch('/portal/ws-1', portal)).toBe('/portal/ws-1');
    expect(bestMatch('/portal/ws-1/upcoming', portal)).toBe('/portal/ws-1/upcoming');
    expect(bestMatch('/portal/ws-1/posts/abc', portal)).toBe('/portal/ws-1');
  });
});
