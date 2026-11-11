import { describe, expect, it, vi } from 'vitest';
import { ConflictError, ForbiddenError, NotFoundError, type TenantContext } from '@orbit/core';
import { bulkPostAction, type BulkPostDeps } from './bulk';
import { bulkPostActionSchema } from './contracts';

const ctx = { organizationId: 'org-1' } as unknown as TenantContext;
const fingerprint = { ip: '127.0.0.1', userAgent: 'vitest' };

const A = '018f4a00-0000-7000-8000-0000000000a1';
const B = '018f4a00-0000-7000-8000-0000000000b2';
const C = '018f4a00-0000-7000-8000-0000000000c3';

function deps(overrides: Partial<BulkPostDeps> = {}): BulkPostDeps {
  return {
    scopeOf: vi.fn(async () => ({
      workspaceId: 'ws-1',
      brandId: 'brand-1',
      createdById: 'user-1',
      status: 'DRAFT' as const,
    })),
    assertCan: vi.fn(),
    deletePost: vi.fn(async () => undefined),
    duplicatePost: vi.fn(async () => ({ id: 'copy-1' }) as never),
    transitionPost: vi.fn(async () => ({}) as never),
    ...overrides,
  } as BulkPostDeps;
}

describe('bulkPostAction', () => {
  it('checks the same permission as the single-post route, for every post', async () => {
    const d = deps();
    await bulkPostAction(ctx, { action: 'delete', postIds: [A, B] }, fingerprint, d);

    expect(d.assertCan).toHaveBeenCalledTimes(2);
    expect(d.assertCan).toHaveBeenCalledWith(ctx, 'post:delete', {
      workspaceId: 'ws-1',
      brandId: 'brand-1',
      createdById: 'user-1',
      status: 'DRAFT',
    });
    expect(d.deletePost).toHaveBeenCalledTimes(2);
  });

  /**
   * Some posts done, some refused, each with its reason — not all or nothing,
   * and a refusal never stops the rest.
   */
  it('answers per post: done, refused with the reason, or not found', async () => {
    const d = deps({
      scopeOf: vi.fn(async (_ctx, id: string) => {
        if (id === C) throw new NotFoundError('Post');
        return { workspaceId: 'ws-1', brandId: 'b', createdById: 'u', status: 'DRAFT' as const };
      }) as BulkPostDeps['scopeOf'],
      deletePost: vi.fn(async (_ctx, id: string) => {
        if (id === B) {
          throw new ConflictError('Cannot delete a published post', {
            userMessage: 'This post has already been published.',
          });
        }
      }) as BulkPostDeps['deletePost'],
    });

    const result = await bulkPostAction(
      ctx,
      { action: 'delete', postIds: [A, B, C] },
      fingerprint,
      d,
    );

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.results).toEqual([
      { postId: A, ok: true },
      expect.objectContaining({
        postId: B,
        ok: false,
        message: 'This post has already been published.',
      }),
      expect.objectContaining({ postId: C, ok: false, code: 'NOT_FOUND' }),
    ]);
  });

  it('does nothing to a post the viewer may not touch', async () => {
    const d = deps({
      assertCan: vi.fn(() => {
        throw new ForbiddenError('denied');
      }) as BulkPostDeps['assertCan'],
    });

    const result = await bulkPostAction(ctx, { action: 'delete', postIds: [A] }, fingerprint, d);

    expect(d.deletePost).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('duplicates under post:create and returns the new post', async () => {
    const d = deps();
    const result = await bulkPostAction(ctx, { action: 'duplicate', postIds: [A] }, fingerprint, d);

    expect(d.assertCan).toHaveBeenCalledWith(ctx, 'post:create', expect.anything());
    expect(result.results[0]).toEqual({ postId: A, ok: true, newPostId: 'copy-1' });
  });

  /** Cancelling goes through the state machine, which checks its own permission. */
  it('cancels through the state machine', async () => {
    const d = deps();
    await bulkPostAction(ctx, { action: 'cancel', postIds: [A] }, fingerprint, d);

    expect(d.transitionPost).toHaveBeenCalledWith(ctx, A, 'CANCELED', fingerprint);
  });
});

describe('bulkPostActionSchema', () => {
  it('acts on each post once, however often it is named', () => {
    expect(bulkPostActionSchema.parse({ action: 'delete', postIds: [A, A, B] }).postIds).toEqual([
      A,
      B,
    ]);
  });

  it('refuses an empty selection, a bad id, an unknown action and more than a page', () => {
    expect(bulkPostActionSchema.safeParse({ action: 'delete', postIds: [] }).success).toBe(false);
    expect(bulkPostActionSchema.safeParse({ action: 'delete', postIds: ['x'] }).success).toBe(
      false,
    );
    expect(bulkPostActionSchema.safeParse({ action: 'publish', postIds: [A] }).success).toBe(false);
    const tooMany = Array.from(
      { length: 101 },
      (_, i) => `018f4a00-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(bulkPostActionSchema.safeParse({ action: 'delete', postIds: tooMany }).success).toBe(
      false,
    );
  });
});
