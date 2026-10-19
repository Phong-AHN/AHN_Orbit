import { describe, expect, it } from 'vitest';
import {
  buildThread,
  compactAge,
  comparePosts,
  needsReply,
  summarizePost,
  summariesFromGroups,
  threadStyle,
  type CommentGroup,
  type ThreadComment,
} from './thread';

let seq = 0;
function comment(overrides: Partial<ThreadComment> & { externalId: string }): ThreadComment {
  seq += 1;
  return {
    id: `id-${seq}`,
    parentExternalId: null,
    origin: 'AUDIENCE',
    state: 'NEW',
    postedAt: new Date(`2026-10-20T10:${String(seq).padStart(2, '0')}:00Z`),
    ...overrides,
  };
}

describe('buildThread', () => {
  it('hangs replies under the comment they answer', () => {
    const question = comment({ externalId: 'q' });
    const answer = comment({ externalId: 'a', parentExternalId: 'q', origin: 'ORBIT' });

    const thread = buildThread([question, answer]);

    expect(thread).toHaveLength(1);
    expect(thread[0]!.comment.externalId).toBe('q');
    expect(thread[0]!.replies.map((r) => r.externalId)).toEqual(['a']);
  });

  /**
   * Instagram attaches a reply aimed at a reply to the top-level comment
   * (D-103), and Facebook draws deeper nesting flat. One level is faithful to
   * both: a reply to a reply belongs under the top-level comment.
   */
  it('places a reply to a reply under the top-level comment', () => {
    const top = comment({ externalId: 'top' });
    const first = comment({ externalId: 'r1', parentExternalId: 'top' });
    const nested = comment({ externalId: 'r2', parentExternalId: 'r1' });

    const thread = buildThread([top, first, nested]);

    expect(thread).toHaveLength(1);
    expect(thread[0]!.replies.map((r) => r.externalId)).toEqual(['r1', 'r2']);
  });

  /**
   * The parent may be deleted, beyond the ingestion horizon, or moved by
   * Instagram before ingestion caught up. Dropping the reply would hide the
   * agency's own answer; promoting it keeps it visible.
   */
  it('promotes an orphaned reply instead of dropping it', () => {
    const orphan = comment({ externalId: 'lonely', parentExternalId: 'gone', origin: 'ORBIT' });

    const thread = buildThread([orphan]);

    expect(thread).toHaveLength(1);
    expect(thread[0]!.comment.externalId).toBe('lonely');
  });

  it('never loses a comment, whatever the shape', () => {
    const all = [
      comment({ externalId: 'a' }),
      comment({ externalId: 'b', parentExternalId: 'a' }),
      comment({ externalId: 'c', parentExternalId: 'b' }),
      comment({ externalId: 'd', parentExternalId: 'missing' }),
      comment({ externalId: 'e' }),
    ];

    const thread = buildThread(all);
    const rendered = thread.flatMap((n) => [n.comment, ...n.replies]).map((c) => c.externalId);

    expect(rendered.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  /** A cycle in the data must not hang the page. */
  it('terminates on a parent cycle', () => {
    const x = comment({ externalId: 'x', parentExternalId: 'y' });
    const y = comment({ externalId: 'y', parentExternalId: 'x' });

    const thread = buildThread([x, y]);
    const rendered = thread.flatMap((n) => [n.comment, ...n.replies]);

    expect(rendered).toHaveLength(2);
  });

  it('orders top-level and replies oldest first', () => {
    const late = comment({ externalId: 'late', postedAt: new Date('2026-10-20T12:00:00Z') });
    const early = comment({ externalId: 'early', postedAt: new Date('2026-10-20T09:00:00Z') });

    expect(buildThread([late, early]).map((n) => n.comment.externalId)).toEqual(['early', 'late']);
  });
});

describe('needsReply', () => {
  it('is only the audience, and only while unhandled', () => {
    expect(needsReply({ origin: 'AUDIENCE', state: 'NEW' })).toBe(true);
    expect(needsReply({ origin: 'AUDIENCE', state: 'HANDLED' })).toBe(false);
    // The agency's own reply is never work.
    expect(needsReply({ origin: 'ORBIT', state: 'NEW' })).toBe(false);
  });
});

describe('summarizePost', () => {
  /** "How much did people say" — our own answers are not what people said. */
  it('counts the audience and excludes the agency’s replies', () => {
    const summary = summarizePost([
      comment({ externalId: 'q1' }),
      comment({ externalId: 'q2', state: 'HANDLED' }),
      comment({ externalId: 'a1', origin: 'ORBIT', state: 'HANDLED' }),
    ]);

    expect(summary.audience).toBe(2);
    expect(summary.needsReply).toBe(1);
  });

  it('tracks the latest audience comment, ignoring our own', () => {
    const summary = summarizePost([
      comment({ externalId: 'q', postedAt: new Date('2026-10-20T08:00:00Z') }),
      comment({ externalId: 'a', origin: 'ORBIT', postedAt: new Date('2026-10-20T23:00:00Z') }),
    ]);

    expect(summary.latestAudienceAt).toBe(Date.parse('2026-10-20T08:00:00Z'));
  });
});

describe('comparePosts', () => {
  /**
   * A queue is a list of things to do. Pure recency would bury an old
   * unanswered question beneath a fresh post everyone has dealt with.
   */
  it('puts posts with something waiting first, whatever their age', () => {
    const oldWaiting = { audience: 1, needsReply: 1, latestAudienceAt: 1_000 };
    const freshDone = { audience: 5, needsReply: 0, latestAudienceAt: 9_000 };

    expect([freshDone, oldWaiting].sort(comparePosts)[0]).toBe(oldWaiting);
  });

  it('breaks ties by most recent activity', () => {
    const older = { audience: 1, needsReply: 1, latestAudienceAt: 1_000 };
    const newer = { audience: 1, needsReply: 1, latestAudienceAt: 5_000 };

    expect([older, newer].sort(comparePosts)[0]).toBe(newer);
  });
});

describe('threadStyle', () => {
  it('draws each platform its own way, and anything else neutrally', () => {
    expect(threadStyle('INSTAGRAM')).toBe('INSTAGRAM');
    expect(threadStyle('FACEBOOK')).toBe('FACEBOOK');
    expect(threadStyle('THREADS')).toBe('GENERIC');
  });
});

describe('compactAge', () => {
  const now = new Date('2026-10-20T12:00:00Z');

  it.each([
    ['2026-10-20T11:59:40Z', 'now'],
    ['2026-10-20T11:55:00Z', '5m'],
    ['2026-10-20T09:00:00Z', '3h'],
    ['2026-10-18T12:00:00Z', '2d'],
    ['2026-10-04T12:00:00Z', 'Oct 4'],
  ])('%s → %s', (at, expected) => {
    expect(compactAge(at, now)).toBe(expected);
  });

  /** A timestamp a little in the future must not render as negative. */
  it('clamps a future time to now', () => {
    expect(compactAge('2026-10-20T12:00:30Z', now)).toBe('now');
  });
});

/**
 * The list page counts with a grouped query; the detail page counts rows. Both
 * must mean the same thing by "needs a reply", or a card would promise three
 * waiting comments and the thread would show two.
 */
describe('summariesFromGroups agrees with summarizePost', () => {
  it('produces the identical summary from grouped counts', () => {
    const rows = [
      comment({ externalId: 'a', postedAt: new Date('2026-10-20T08:00:00Z') }),
      comment({ externalId: 'b', postedAt: new Date('2026-10-20T09:00:00Z') }),
      comment({ externalId: 'c', state: 'HANDLED', postedAt: new Date('2026-10-20T11:00:00Z') }),
      comment({
        externalId: 'd',
        origin: 'ORBIT',
        state: 'HANDLED',
        postedAt: new Date('2026-10-20T23:00:00Z'),
      }),
    ];

    const groups = new Map<string, CommentGroup>();
    for (const row of rows) {
      const key = `${row.origin}:${row.state}`;
      const at = row.postedAt instanceof Date ? row.postedAt : new Date(row.postedAt);
      const existing = groups.get(key);
      groups.set(key, {
        postVariantId: 'v1',
        origin: row.origin,
        state: row.state,
        count: (existing?.count ?? 0) + 1,
        latestAt: existing?.latestAt && existing.latestAt > at ? existing.latestAt : at,
      });
    }

    expect(summariesFromGroups([...groups.values()]).get('v1')).toEqual(summarizePost(rows));
  });

  it('keeps posts separate', () => {
    const result = summariesFromGroups([
      { postVariantId: 'v1', origin: 'AUDIENCE', state: 'NEW', count: 2, latestAt: null },
      { postVariantId: 'v2', origin: 'AUDIENCE', state: 'HANDLED', count: 5, latestAt: null },
    ]);

    expect(result.get('v1')?.needsReply).toBe(2);
    expect(result.get('v2')?.needsReply).toBe(0);
    expect(result.get('v2')?.audience).toBe(5);
  });
});
