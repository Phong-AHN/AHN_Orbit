import { isAppError, type TenantContext } from '@orbit/core';
import { assertCan } from '@orbit/rbac';
import { logger } from '@orbit/observability';
import type { AuditInput } from '@/server/audit';
import type { BulkPostAction, BulkPostActionInput } from './contracts';
import { deletePost, duplicatePost, postScope, transitionPost } from './service';

/**
 * One action applied to several posts — from the list's selection.
 *
 * **Each post is decided on its own.** Nothing about the request widens what
 * the caller may do: every post is resolved through the tenant-scoped client
 * (another organization's id is simply not found), and the same permission and
 * the same service rules apply as when acting on that one post from its own
 * page. A Content Creator can delete their own drafts and no one else's; a
 * published post cannot be deleted; a cancellation goes through the state
 * machine. So the answer is per post: some may be done and some refused, each
 * with its reason, rather than all or nothing.
 *
 * Sequential on purpose: at most one page of posts, and each step writes its
 * own audit row in its own transaction.
 */

export interface BulkPostResult {
  postId: string;
  ok: boolean;
  /** When refused: the code and the sentence the person sees. */
  code?: string;
  message?: string;
  /** For duplicate: the new post. */
  newPostId?: string;
}

/** The steps, injectable so the per-post decisions can be tested without a database. */
export interface BulkPostDeps {
  scopeOf: typeof postScope;
  assertCan: typeof assertCan;
  deletePost: typeof deletePost;
  duplicatePost: typeof duplicatePost;
  transitionPost: typeof transitionPost;
}

const DEFAULT_DEPS: BulkPostDeps = {
  scopeOf: postScope,
  assertCan,
  deletePost,
  duplicatePost,
  transitionPost,
};

export async function bulkPostAction(
  ctx: TenantContext,
  input: BulkPostActionInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
  deps: BulkPostDeps = DEFAULT_DEPS,
): Promise<{
  action: BulkPostAction;
  succeeded: number;
  failed: number;
  results: BulkPostResult[];
}> {
  const results: BulkPostResult[] = [];

  for (const postId of input.postIds) {
    try {
      const result = await applyOne(ctx, input.action, postId, fingerprint, deps);
      results.push(result);
    } catch (error) {
      if (!isAppError(error)) {
        logger.error('bulk post action failed unexpectedly', {
          action: input.action,
          postId,
          organizationId: ctx.organizationId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      results.push({
        postId,
        ok: false,
        code: isAppError(error) ? error.code : 'INTERNAL_ERROR',
        message: isAppError(error) ? error.userMessage : 'Something went wrong with this post.',
      });
    }
  }

  const succeeded = results.filter((result) => result.ok).length;
  return { action: input.action, succeeded, failed: results.length - succeeded, results };
}

async function applyOne(
  ctx: TenantContext,
  action: BulkPostAction,
  postId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
  deps: BulkPostDeps,
): Promise<BulkPostResult> {
  // Through the tenant-scoped client: another organization's id is a 404 here.
  const post = await deps.scopeOf(ctx, postId);
  const scope = {
    workspaceId: post.workspaceId,
    brandId: post.brandId,
    createdById: post.createdById,
    status: post.status,
  };

  switch (action) {
    case 'delete':
      // The permission `DELETE /posts/{id}` checks, with the same scope.
      deps.assertCan(ctx, 'post:delete', scope);
      await deps.deletePost(ctx, postId, fingerprint);
      return { postId, ok: true };

    case 'duplicate': {
      // The permission `POST /posts/{id}/duplicate` checks.
      deps.assertCan(ctx, 'post:create', scope);
      const copy = await deps.duplicatePost(ctx, postId, fingerprint);
      return { postId, ok: true, newPostId: copy.id };
    }

    case 'cancel':
      // Through the state machine, which names and checks the permission for
      // this move from this status, as `/transition` does.
      await deps.transitionPost(ctx, postId, 'CANCELED', fingerprint);
      return { postId, ok: true };

    default: {
      const exhaustive: never = action;
      throw new Error(`Unhandled bulk action: ${String(exhaustive)}`);
    }
  }
}
