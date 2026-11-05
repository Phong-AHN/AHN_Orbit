import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, fixedClock, setClock, type TenantContext } from '@orbit/core';
import { enqueue } from '@orbit/queue';
import { publishNow } from './service';
import { reschedulePost, schedulePost } from '../scheduling/service';

/**
 * Which accounts each way of sending a post out takes with it.
 *
 * The rule is a status filter, so a stand-in that honours the filter is enough
 * to pin it; the state machine and RLS around it are the integration suite's.
 * The stand-in matters here because the filter is the bug: it dropped FAILED,
 * so a failed post read as a post with no accounts, and the only way on was to
 * untick and re-tick each one — which recreates the variant and loses its
 * overrides.
 */

interface Row {
  id: string;
  status: string;
  body: string;
  linkUrl: string | null;
  media: Array<{ mediaAssetId: string }>;
  scheduledFor: Date | null;
  contentHash: string | null;
}

interface StatusFilter {
  status: { in: string[] };
}

const fake = vi.hoisted(() => {
  const state = { rows: [] as Row[], postStatus: 'FAILED' };

  const db = {
    post: {
      findFirst: ({ select }: { select: { variants?: { where: StatusFilter } } }) => {
        const wanted = select.variants?.where.status.in;
        return Promise.resolve({
          id: 'post-1',
          status: state.postStatus,
          body: 'The caption',
          workspaceId: 'workspace-1',
          brandId: 'brand-1',
          createdById: 'user-1',
          scheduledFor: null,
          timezone: null,
          media: [],
          variants: wanted ? state.rows.filter((row) => wanted.includes(row.status)) : undefined,
        });
      },
      findFirstOrThrow: () => Promise.resolve({ id: 'post-1' }),
      update: () => Promise.resolve({}),
    },
    postVariant: {
      update: ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = state.rows.find((candidate) => candidate.id === where.id);
        if (row) Object.assign(row, data);
        return Promise.resolve(row);
      },
      findMany: ({ where }: { where: { status: string } }) =>
        Promise.resolve(state.rows.filter((row) => row.status === where.status)),
      count: ({ where }: { where: StatusFilter }) =>
        Promise.resolve(state.rows.filter((row) => where.status.in.includes(row.status)).length),
    },
    workspace: { findFirst: () => Promise.resolve({ timezone: 'UTC' }) },
    publishingJob: {
      findFirst: () => Promise.resolve(null),
      create: () => Promise.resolve({ id: 'job-1' }),
    },
  };

  return { state, db };
});

vi.mock('@orbit/db', () => ({
  withTenant: (_ctx: unknown, work: (db: unknown) => unknown) => work(fake.db),
}));
vi.mock('@orbit/queue', () => ({ enqueue: vi.fn(() => Promise.resolve()) }));
vi.mock('@orbit/observability', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('@orbit/rbac', () => ({ assertCan: vi.fn() }));
vi.mock('@/server/audit', () => ({ audit: vi.fn(() => Promise.resolve()) }));
vi.mock('@/features/posts/validation', () => ({ validatePost: vi.fn() }));
vi.mock('@/features/posts/service', () => ({
  transitionPost: async (
    _ctx: unknown,
    _postId: string,
    _to: string,
    _fingerprint: unknown,
    options: { onTransition: (db: unknown, post: unknown) => Promise<void> },
  ) => {
    await options.onTransition(fake.db, {});
    return { id: 'post-1' };
  },
}));

const NOW = new Date('2026-11-05T09:00:00Z');
const LATER = '2026-11-06T09:00:00.000Z';
const ctx = { organizationId: 'org-1', correlationId: 'test' } as unknown as TenantContext;
const fingerprint = { ip: '127.0.0.1', userAgent: 'vitest' };

function variant(id: string, status: string): Row {
  return {
    id,
    status,
    body: '',
    linkUrl: null,
    media: [],
    scheduledFor: null,
    contentHash: null,
  };
}

function statuses(): Record<string, string> {
  return Object.fromEntries(fake.state.rows.map((row) => [row.id, row.status]));
}

let restoreClock: () => void;

beforeEach(() => {
  restoreClock = setClock(fixedClock(NOW));
  vi.mocked(enqueue).mockClear();
  fake.state.postStatus = 'FAILED';
});

afterEach(() => {
  restoreClock();
});

describe('publishing a failed post again', () => {
  it('goes to the accounts it already had, with nothing to tick again', async () => {
    fake.state.rows = [variant('x', 'FAILED'), variant('pinterest', 'FAILED')];

    const result = await publishNow(ctx, 'post-1', fingerprint);

    expect(statuses()).toEqual({ x: 'SCHEDULED', pinterest: 'SCHEDULED' });
    expect(result.enqueued).toBe(2);
    // Stamped afresh: the post may have been edited since it failed.
    expect(fake.state.rows.every((row) => row.contentHash !== null)).toBe(true);
    expect(fake.state.rows.every((row) => row.scheduledFor?.getTime() === NOW.getTime())).toBe(
      true,
    );
  });

  it('touches only the accounts that failed on a partly published post', async () => {
    fake.state.postStatus = 'PARTIALLY_PUBLISHED';
    fake.state.rows = [
      variant('facebook', 'PUBLISHED'),
      variant('x', 'FAILED'),
      variant('tiktok', 'NEEDS_REVIEW'),
    ];

    const result = await publishNow(ctx, 'post-1', fingerprint);

    // Published must never go out twice, and nobody knows whether a parked one
    // went out at all.
    expect(statuses()).toEqual({
      facebook: 'PUBLISHED',
      x: 'SCHEDULED',
      tiktok: 'NEEDS_REVIEW',
    });
    expect(result.enqueued).toBe(1);
  });

  it('says so when no account is left, rather than asking for one', async () => {
    fake.state.postStatus = 'PARTIALLY_PUBLISHED';
    fake.state.rows = [variant('facebook', 'PUBLISHED'), variant('tiktok', 'NEEDS_REVIEW')];

    const refusal = await publishNow(ctx, 'post-1', fingerprint).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ConflictError);
    expect((refusal as ConflictError).userMessage).toBe(
      'Every account either published or is waiting for a decision.',
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('scheduling a failed post again', () => {
  it('goes to the accounts it already had', async () => {
    fake.state.rows = [variant('x', 'FAILED')];

    await schedulePost(ctx, 'post-1', { scheduledForUtc: LATER }, fingerprint);

    expect(statuses()).toEqual({ x: 'SCHEDULED' });
    expect(fake.state.rows[0]?.scheduledFor?.toISOString()).toBe(LATER);
  });

  it('says so when no account is left, rather than asking for one', async () => {
    fake.state.postStatus = 'PARTIALLY_PUBLISHED';
    fake.state.rows = [variant('facebook', 'PUBLISHED')];

    const refusal = await schedulePost(
      ctx,
      'post-1',
      { scheduledForUtc: LATER },
      fingerprint,
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ConflictError);
  });
});

describe('rescheduling', () => {
  /**
   * `post:reschedule` is a lesser right than `post:retry_failed`, and some
   * roles hold one without the other. Moving a post must not be a way to retry
   * it.
   */
  it('leaves a failed account failed', async () => {
    fake.state.postStatus = 'SCHEDULED';
    fake.state.rows = [variant('facebook', 'SCHEDULED'), variant('x', 'FAILED')];

    await reschedulePost(ctx, 'post-1', { scheduledForUtc: LATER }, fingerprint);

    expect(statuses()).toEqual({ facebook: 'SCHEDULED', x: 'FAILED' });
    expect(fake.state.rows[0]?.scheduledFor?.toISOString()).toBe(LATER);
    expect(fake.state.rows[1]?.scheduledFor).toBeNull();
  });
});
