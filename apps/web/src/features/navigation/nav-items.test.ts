import { describe, expect, it } from 'vitest';

import { bestMatch } from './active-path';
import { ADMIN_NAV, NAV_GROUPS, PORTAL_NAV, shellGroups } from './nav-items';

describe('shellGroups', () => {
  it('prefixes every destination with the surface base', () => {
    const groups = shellGroups('/orgs/ahn', NAV_GROUPS);
    const hrefs = groups.flatMap((group) => group.items.map((item) => item.href));

    expect(hrefs).toContain('/orgs/ahn/posts');
    expect(hrefs.every((href) => href.startsWith('/orgs/ahn'))).toBe(true);
  });

  /**
   * A destination at the surface root has an empty path, so the base alone is
   * the href. A trailing slash here would never match the pathname and the item
   * would sit permanently unmarked.
   */
  it('leaves no trailing slash on a destination at the surface root', () => {
    const [group] = shellGroups('/portal/ws-1', PORTAL_NAV);

    expect(group?.items[0]?.href).toBe('/portal/ws-1');
  });

  it('carries `exact` across so a root destination does not claim every page', () => {
    const [group] = shellGroups('/portal/ws-1', PORTAL_NAV);
    const root = group?.items[0];

    expect(root?.exact).toBe(true);
    // Which is the behaviour that matters: proven against the matcher, not just
    // asserted as a flag.
    expect(bestMatch('/portal/ws-1/upcoming', group?.items ?? [])).toBe('/portal/ws-1/upcoming');
  });

  it('omits a destination whose permission the principal lacks', () => {
    const groups = shellGroups('/orgs/ahn', NAV_GROUPS, (permission) => permission === 'post:read');
    const labels = groups.flatMap((group) => group.items.map((item) => item.label));

    expect(labels).toContain('Posts');
    expect(labels).not.toContain('Team');
    expect(labels).not.toContain('Analytics');
    expect(labels).not.toContain('AI Assistant');
  });

  /** A feature of its own, not a detail of a brand's page (D-108). */
  it('gives the AI Assistant its own section for whoever may configure it', () => {
    const groups = shellGroups(
      '/orgs/ahn',
      NAV_GROUPS,
      (permission) => permission === 'ai_assistant:manage',
    );

    expect(groups.find((group) => group.label === 'AI')?.items).toEqual([
      { label: 'AI Assistant', href: '/orgs/ahn/assistant' },
    ]);
  });

  /** An unguarded destination belongs to everyone who reached the surface. */
  it('keeps destinations that carry no permission at all', () => {
    const groups = shellGroups('/orgs/ahn', NAV_GROUPS, () => false);
    const labels = groups.flatMap((group) => group.items.map((item) => item.label));

    expect(labels).toEqual(['Today']);
  });

  /**
   * A heading with nothing under it is worse than a missing section: it tells
   * somebody a part of the product exists and then shows them none of it.
   */
  it('drops a group once every destination in it is filtered away', () => {
    const groups = shellGroups('/orgs/ahn', NAV_GROUPS, (permission) => permission === 'post:read');

    expect(groups.map((group) => group.label)).not.toContain('Settings');
    expect(groups.every((group) => group.items.length > 0)).toBe(true);
  });

  it('passes everything through on a surface whose gate is the surface itself', () => {
    const admin = shellGroups('/admin', ADMIN_NAV);

    expect(admin.flatMap((group) => group.items.map((item) => item.href))).toEqual([
      '/admin',
      '/admin/jobs',
      '/admin/organizations',
      '/admin/users',
      '/admin/accounts',
    ]);
  });
});

/**
 * Every surface's own destinations, checked against the matcher together.
 *
 * Each `href` a surface produces must mark itself and nothing else. The failure
 * this catches is a new destination that happens to be a prefix of an existing
 * one — added in the declaration, where the consequence is invisible.
 */
describe.each([
  ['agency', '/orgs/ahn', NAV_GROUPS],
  ['portal', '/portal/ws-1', PORTAL_NAV],
  ['admin', '/admin', ADMIN_NAV],
] as const)('%s destinations', (_name, base, declaration) => {
  const items = shellGroups(base, declaration).flatMap((group) => group.items);

  it('each destination marks itself', () => {
    for (const item of items) {
      expect(bestMatch(item.href, items)).toBe(item.href);
    }
  });

  it('has no two destinations at the same href', () => {
    const hrefs = items.map((item) => item.href);

    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
