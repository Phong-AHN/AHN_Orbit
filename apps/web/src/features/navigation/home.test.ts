import { describe, expect, it } from 'vitest';

import { continuePath, resolveHome, safeNext, type HomeFacts } from './home';

const facts = (over: Partial<HomeFacts> = {}): HomeFacts => ({
  agency: [],
  portal: [],
  isPlatformAdmin: false,
  ...over,
});

describe('resolveHome', () => {
  it('sends staff of one organization straight into it', () => {
    expect(resolveHome(facts({ agency: [{ slug: 'ahn' }] }))).toEqual({
      surface: 'agency',
      path: '/orgs/ahn/dashboard',
    });
  });

  /** Guessing would put somebody in the wrong client's data. */
  it('asks staff of several organizations which one', () => {
    expect(resolveHome(facts({ agency: [{ slug: 'ahn' }, { slug: 'other' }] }))).toEqual({
      surface: 'agency',
      path: '/orgs',
    });
  });

  /**
   * The behaviour this module exists to fix. A client used to be sent to the
   * organization picker, which forwards anyone with one organization into the
   * agency dashboard — a surface whose API refuses them on every call.
   */
  it('sends a client to their portal, never to the agency surface', () => {
    const home = resolveHome(facts({ portal: [{ id: 'ws-1' }] }));

    expect(home).toEqual({ surface: 'portal', path: '/portal/ws-1' });
    expect(home.path).not.toContain('/orgs');
  });

  it('asks a client with several workspaces which one', () => {
    expect(resolveHome(facts({ portal: [{ id: 'ws-1' }, { id: 'ws-2' }] }))).toEqual({
      surface: 'portal',
      path: '/portal',
    });
  });

  it('sends a platform admin with no membership to operations', () => {
    expect(resolveHome(facts({ isPlatformAdmin: true }))).toEqual({
      surface: 'ops',
      path: '/admin',
    });
  });

  /**
   * Operations is a tool somebody opens deliberately, not a place they live.
   * An engineer who also runs an agency should land in the product.
   */
  it('prefers the product over operations for somebody who holds both', () => {
    expect(resolveHome(facts({ agency: [{ slug: 'ahn' }], isPlatformAdmin: true }))).toEqual({
      surface: 'agency',
      path: '/orgs/ahn/dashboard',
    });
  });

  it('honours the operations entrance for an admin who asks for it', () => {
    expect(
      resolveHome(facts({ agency: [{ slug: 'ahn' }], isPlatformAdmin: true }), 'ops'),
    ).toEqual({ surface: 'ops', path: '/admin' });
  });

  /**
   * The entrance states intent and cannot grant anything. A non-admin asking
   * for operations gets their own home, not a 404 and not an error — which is
   * also what stops the three entrances reporting what kind of account an
   * address is.
   */
  it('ignores the operations entrance for somebody who is not an admin', () => {
    expect(resolveHome(facts({ agency: [{ slug: 'ahn' }] }), 'ops')).toEqual({
      surface: 'agency',
      path: '/orgs/ahn/dashboard',
    });
  });

  it('lets the portal entrance reach the portal for somebody who is also staff', () => {
    const both = facts({ agency: [{ slug: 'ahn' }], portal: [{ id: 'ws-1' }] });

    expect(resolveHome(both, 'portal')).toEqual({ surface: 'portal', path: '/portal/ws-1' });
    // And without that hint, staff membership wins.
    expect(resolveHome(both)).toEqual({ surface: 'agency', path: '/orgs/ahn/dashboard' });
  });

  it('ignores the portal entrance for somebody who is a client nowhere', () => {
    expect(resolveHome(facts({ agency: [{ slug: 'ahn' }] }), 'portal')).toEqual({
      surface: 'agency',
      path: '/orgs/ahn/dashboard',
    });
  });

  /** An unaccepted invitation, or a membership revoked mid-session. */
  it('has no path for somebody entitled to nothing', () => {
    expect(resolveHome(facts())).toEqual({ surface: 'none', path: null });
    expect(resolveHome(facts(), 'ops')).toEqual({ surface: 'none', path: null });
  });
});

describe('safeNext', () => {
  it('follows a same-site path', () => {
    expect(safeNext('/orgs/ahn/posts/018f-abc')).toBe('/orgs/ahn/posts/018f-abc');
    expect(safeNext('/portal/ws-1/upcoming')).toBe('/portal/ws-1/upcoming');
  });

  it('refuses an absolute URL to another origin', () => {
    expect(safeNext('https://evil.example/steal')).toBeNull();
    expect(safeNext('http://evil.example')).toBeNull();
  });

  /**
   * A protocol-relative URL starts with a slash and is still another origin —
   * the case a naive `startsWith('/')` check lets straight through.
   */
  it('refuses a protocol-relative URL', () => {
    expect(safeNext('//evil.example/steal')).toBeNull();
  });

  /** Otherwise signing in returns you to the page you just signed in on. */
  it('refuses a path that would loop back into the sign-in flow', () => {
    expect(safeNext('/sign-in')).toBeNull();
    expect(safeNext('/sign-in?next=/sign-in')).toBeNull();
    expect(safeNext('/sign-in/client')).toBeNull();
    expect(safeNext('/sign-in/ops')).toBeNull();
    // `/continue` exists only to redirect somewhere else.
    expect(safeNext('/continue')).toBeNull();
    expect(safeNext('/continue?entrance=ops')).toBeNull();
  });

  /** A real destination that merely starts with the same letters is fine. */
  it('does not mistake a real page for an entrance', () => {
    expect(safeNext('/sign-in-help')).toBe('/sign-in-help');
  });

  it('treats a missing or empty value as no destination', () => {
    expect(safeNext(null)).toBeNull();
    expect(safeNext(undefined)).toBeNull();
    expect(safeNext('')).toBeNull();
  });
});

describe('continuePath', () => {
  it('carries the entrance so the surface can break a tie', () => {
    expect(continuePath('ops')).toBe('/continue?entrance=ops');
    expect(continuePath('portal')).toBe('/continue?entrance=portal');
  });

  it('carries a destination worth returning to', () => {
    expect(continuePath('agency', '/orgs/ahn/posts/abc')).toBe(
      '/continue?entrance=agency&next=%2Forgs%2Fahn%2Fposts%2Fabc',
    );
  });

  /** The guard is applied once here rather than in each sign-in form. */
  it('drops a destination that is not safe to follow', () => {
    expect(continuePath('agency', '//evil.example')).toBe('/continue?entrance=agency');
    expect(continuePath('agency', 'https://evil.example')).toBe('/continue?entrance=agency');
    expect(continuePath('agency', '/sign-in')).toBe('/continue?entrance=agency');
  });

  it('omits the destination when there is none', () => {
    expect(continuePath('agency', null)).toBe('/continue?entrance=agency');
    expect(continuePath('agency')).toBe('/continue?entrance=agency');
  });
});
