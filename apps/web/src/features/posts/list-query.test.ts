import { describe, expect, it } from 'vitest';
import { isFiltered, postListOrder, postListWhere, readPostListParams } from './list-query';

const WS_A = '018f4a00-0000-7000-8000-00004a1f0002';
const WS_B = '018f4b00-0000-7000-8000-00004b1f0002';
const BRAND = '018f4a00-0000-7000-8000-00004a1f0003';

describe('readPostListParams', () => {
  it('reads every parameter it knows', () => {
    expect(
      readPostListParams(
        new URLSearchParams({
          q: '  summer sale ',
          status: 'SCHEDULED',
          platform: 'TIKTOK',
          workspaceId: WS_A,
          brandId: BRAND,
          sort: 'newest',
        }),
      ),
    ).toEqual({
      search: 'summer sale',
      status: 'SCHEDULED',
      platform: 'TIKTOK',
      workspaceId: WS_A,
      brandId: BRAND,
      sort: 'newest',
    });
  });

  it('reads the page’s search params the same way', () => {
    expect(readPostListParams({ q: ['first', 'second'], sort: undefined })).toEqual({
      search: 'first',
      sort: 'upcoming',
    });
  });

  /** An id that is not a UUID would make the database refuse the whole query. */
  it('drops anything that is not one of its values', () => {
    expect(
      readPostListParams(
        new URLSearchParams({
          q: '   ',
          status: 'DELETED',
          platform: 'MYSPACE',
          workspaceId: 'not-a-uuid',
          brandId: "1' OR '1'='1",
          sort: 'random',
        }),
      ),
    ).toEqual({ sort: 'upcoming' });
  });

  it('caps the search at 100 characters', () => {
    expect(readPostListParams({ q: 'x'.repeat(500) }).search).toHaveLength(100);
  });

  it('says whether anything narrows the list; the sort does not', () => {
    expect(isFiltered(readPostListParams({ sort: 'oldest' }))).toBe(false);
    expect(isFiltered(readPostListParams({ platform: 'X' }))).toBe(true);
  });
});

describe('postListWhere', () => {
  /**
   * The bug this replaces: the access rule and the request's own filter were
   * spread into one object, so the access rule replaced the filter. Somebody
   * with access to some clients who picked one still saw all of them.
   */
  it('keeps a client filter alongside the viewer’s access, both applied', () => {
    const where = postListWhere({ workspaceId: WS_A }, { accessibleWorkspaces: [WS_A, WS_B] });
    expect(where.AND).toEqual(
      expect.arrayContaining([{ workspaceId: { in: [WS_A, WS_B] } }, { workspaceId: WS_A }]),
    );
  });

  it('never widens access: a client outside the viewer’s reach still has the access rule', () => {
    const where = postListWhere({ workspaceId: WS_B }, { accessibleWorkspaces: [WS_A] });
    expect(where.AND).toEqual(expect.arrayContaining([{ workspaceId: { in: [WS_A] } }]));
  });

  /** A Client's status filter used to be dropped in favour of their visible set. */
  it('applies a Client’s status filter inside what they may see', () => {
    const where = postListWhere(
      { status: 'CLIENT_REVIEW' },
      { visibleStatuses: ['CLIENT_REVIEW', 'PUBLISHED'] },
    );
    expect(where.AND).toEqual(
      expect.arrayContaining([
        { status: { in: ['CLIENT_REVIEW', 'PUBLISHED'] } },
        { status: 'CLIENT_REVIEW' },
      ]),
    );
  });

  it('matches nothing when a Client asks for a status they may not see', () => {
    const where = postListWhere({ status: 'DRAFT' }, { visibleStatuses: ['PUBLISHED'] });
    expect(where.AND).toEqual(expect.arrayContaining([{ id: { in: [] } }]));
  });

  it('searches title and text without regard to case', () => {
    const where = postListWhere({ search: 'Sale' });
    expect(where.AND).toEqual(
      expect.arrayContaining([
        {
          OR: [
            { title: { contains: 'Sale', mode: 'insensitive' } },
            { body: { contains: 'Sale', mode: 'insensitive' } },
          ],
        },
      ]),
    );
  });

  it('filters by platform through the post’s live variants', () => {
    const where = postListWhere({ platform: 'INSTAGRAM' });
    expect(where.AND).toEqual(
      expect.arrayContaining([{ variants: { some: { platform: 'INSTAGRAM', deletedAt: null } } }]),
    );
  });

  it('always leaves deleted posts out', () => {
    expect(postListWhere({}).AND).toEqual([{ deletedAt: null }]);
  });
});

describe('postListOrder', () => {
  it('keeps the old default: scheduled soonest, unscheduled after', () => {
    expect(postListOrder('upcoming')[0]).toEqual({ scheduledFor: { sort: 'asc', nulls: 'last' } });
  });

  it('puts unpublished posts last when sorting by publication', () => {
    expect(postListOrder('published')[0]).toEqual({
      publishedAt: { sort: 'desc', nulls: 'last' },
    });
  });

  it('ends every order on the id, so equal rows do not swap between loads', () => {
    for (const sort of ['upcoming', 'newest', 'oldest', 'updated', 'published'] as const) {
      const order = postListOrder(sort);
      expect(Object.keys(order[order.length - 1]!)).toEqual(['id']);
    }
  });
});
