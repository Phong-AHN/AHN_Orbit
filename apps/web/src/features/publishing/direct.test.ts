import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@orbit/core';
import { can, canTransition } from '@orbit/rbac';
import { transitionPost } from '@/features/posts/service';
import { decideApproval } from '@/features/approvals/service';
import { checkScheduleIntent, schedulePost } from '@/features/scheduling/service';
import { publishNow } from './service';
import { directPublishOptions, publishWithoutReview } from './direct';

/**
 * Publishing without review, for the agency's own accounts (D-127).
 *
 * The steps themselves — the state machine, validation, the approval record —
 * are the existing functions and their own tests. What is pinned here is the
 * orchestration: who qualifies, that every refusal happens before anything
 * moves, and that the steps run in order without telling reviewers about a
 * review that is not happening.
 */

const fake = vi.hoisted(() => {
  const state = {
    post: null as null | {
      id: string;
      status: string;
      workspaceId: string;
      brandId: string | null;
      createdById: string | null;
      workspace: { requiresClientApproval: boolean } | null;
    },
    gate: { id: 'gate-1' } as { id: string } | null,
  };
  const db = {
    post: { findFirst: () => Promise.resolve(state.post) },
    approval: { findFirst: () => Promise.resolve(state.gate) },
  };
  return { state, db };
});

vi.mock('@orbit/db', () => ({
  withTenant: (_ctx: unknown, run: (db: typeof fake.db) => unknown) => run(fake.db),
}));
vi.mock('@orbit/rbac', () => ({ can: vi.fn(() => true), canTransition: vi.fn(() => true) }));
vi.mock('@/features/posts/service', () => ({
  transitionPost: vi.fn(() => Promise.resolve({ id: 'post-1' })),
}));
vi.mock('@/features/approvals/service', () => ({
  decideApproval: vi.fn(() => Promise.resolve({})),
}));
vi.mock('@/features/scheduling/service', () => ({
  checkScheduleIntent: vi.fn(() => Promise.resolve()),
  schedulePost: vi.fn(() => Promise.resolve({ id: 'post-1', status: 'SCHEDULED' })),
}));
vi.mock('./service', () => ({
  publishNow: vi.fn(() => Promise.resolve({ post: { id: 'post-1' }, enqueued: 1 })),
}));

const ctx = { organizationId: 'org-1' } as TenantContext;
const fingerprint = { ip: '203.0.113.7', userAgent: 'vitest' };
const schedule = { localTime: { year: 2030, month: 1, day: 2, hour: 9, minute: 0 } };

function internalDraft(overrides: Partial<NonNullable<typeof fake.state.post>> = {}) {
  fake.state.post = {
    id: 'post-1',
    status: 'DRAFT',
    workspaceId: 'ws-1',
    brandId: 'brand-1',
    createdById: 'user-1',
    workspace: { requiresClientApproval: false },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(can).mockReturnValue(true);
  vi.mocked(canTransition).mockReturnValue(true);
  fake.state.gate = { id: 'gate-1' };
  internalDraft();
});

describe('publishWithoutReview', () => {
  it('submits, approves without notifying anybody, then schedules', async () => {
    await publishWithoutReview(ctx, 'post-1', { mode: 'schedule', schedule }, fingerprint);

    expect(checkScheduleIntent).toHaveBeenCalledWith(ctx, 'post-1', schedule);
    expect(transitionPost).toHaveBeenCalledWith(
      ctx,
      'post-1',
      'INTERNAL_REVIEW',
      fingerprint,
      expect.objectContaining({ notify: false }),
    );
    expect(decideApproval).toHaveBeenCalledWith(
      ctx,
      'gate-1',
      expect.objectContaining({ decision: 'APPROVED' }),
      fingerprint,
      { notify: false },
    );
    expect(schedulePost).toHaveBeenCalledWith(ctx, 'post-1', schedule, fingerprint);
    expect(publishNow).not.toHaveBeenCalled();

    const order = [transitionPost, decideApproval, schedulePost].map(
      (fn) => vi.mocked(fn).mock.invocationCallOrder[0] ?? 0,
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('publishes now instead of scheduling when asked', async () => {
    await publishWithoutReview(ctx, 'post-1', { mode: 'now' }, fingerprint);

    expect(publishNow).toHaveBeenCalledWith(ctx, 'post-1', fingerprint);
    expect(schedulePost).not.toHaveBeenCalled();
    expect(checkScheduleIntent).not.toHaveBeenCalled();
  });

  it('refuses a client’s post, and moves nothing', async () => {
    internalDraft({ workspace: { requiresClientApproval: true } });

    await expect(
      publishWithoutReview(ctx, 'post-1', { mode: 'now' }, fingerprint),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(transitionPost).not.toHaveBeenCalled();
  });

  it('treats a workspace it cannot read as a client’s', async () => {
    internalDraft({ workspace: null });

    await expect(
      publishWithoutReview(ctx, 'post-1', { mode: 'schedule', schedule }, fingerprint),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(transitionPost).not.toHaveBeenCalled();
  });

  it('refuses a post that is not a draft', async () => {
    internalDraft({ status: 'INTERNAL_REVIEW' });

    await expect(
      publishWithoutReview(ctx, 'post-1', { mode: 'schedule', schedule }, fingerprint),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(transitionPost).not.toHaveBeenCalled();
  });

  it('refuses before the first step when any step would be refused', async () => {
    // May submit and approve, may not schedule.
    vi.mocked(canTransition).mockImplementation((_ctx, from) => from !== 'APPROVED');

    await expect(
      publishWithoutReview(ctx, 'post-1', { mode: 'schedule', schedule }, fingerprint),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(transitionPost).not.toHaveBeenCalled();
  });

  it('refuses publishing now without the right to, even when scheduling is allowed', async () => {
    vi.mocked(can).mockReturnValue(false);

    await expect(
      publishWithoutReview(ctx, 'post-1', { mode: 'now' }, fingerprint),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(transitionPost).not.toHaveBeenCalled();

    // Scheduling is still open to the same person.
    await publishWithoutReview(ctx, 'post-1', { mode: 'schedule', schedule }, fingerprint);
    expect(schedulePost).toHaveBeenCalled();
  });

  it('refuses a bad time before moving the post', async () => {
    vi.mocked(checkScheduleIntent).mockRejectedValueOnce(new Error('in the past'));

    await expect(
      publishWithoutReview(ctx, 'post-1', { mode: 'schedule', schedule }, fingerprint),
    ).rejects.toThrow('in the past');
    expect(transitionPost).not.toHaveBeenCalled();
  });

  it('is not found for a post this organization cannot see', async () => {
    fake.state.post = null;

    await expect(
      publishWithoutReview(ctx, 'post-1', { mode: 'now' }, fingerprint),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('directPublishOptions', () => {
  const draft = {
    status: 'DRAFT' as const,
    workspaceId: 'ws-1',
    brandId: 'brand-1',
    createdById: 'user-1',
    requiresClientApproval: false,
  };

  it('offers scheduling, and publishing now to those with the right', () => {
    expect(directPublishOptions(ctx, draft)).toEqual({ schedule: true, now: true });

    vi.mocked(can).mockReturnValue(false);
    expect(directPublishOptions(ctx, draft)).toEqual({ schedule: true, now: false });
  });

  it('offers nothing for a client’s post or a post past draft', () => {
    expect(directPublishOptions(ctx, { ...draft, requiresClientApproval: true })).toEqual({
      schedule: false,
      now: false,
    });
    expect(directPublishOptions(ctx, { ...draft, status: 'APPROVED' })).toEqual({
      schedule: false,
      now: false,
    });
  });

  it('asks every step with the post’s status at that step, as an internal workspace', () => {
    directPublishOptions(ctx, draft);
    const asked = vi
      .mocked(canTransition)
      .mock.calls.map(([, from, to, scope]) => [
        from,
        to,
        scope?.status,
        scope?.requiresClientApproval,
      ]);
    expect(asked).toEqual([
      ['DRAFT', 'INTERNAL_REVIEW', 'DRAFT', false],
      ['INTERNAL_REVIEW', 'APPROVED', 'INTERNAL_REVIEW', false],
      ['APPROVED', 'SCHEDULED', 'APPROVED', false],
    ]);
  });
});
