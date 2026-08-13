'use client';

import type { ApprovalDecision, ApprovalStage, ApprovalState, PostStatus } from '@orbit/core';
import { ApiError } from '@/features/posts/ui/api';

/**
 * Browser-side client for approvals and comments.
 *
 * Shares `ApiError` with the post client so a 403 renders as a permission state
 * and a 409 as a conflict, uniformly, wherever the call was made from.
 */

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (response.status === 204) return undefined as T;

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const envelope =
      body && typeof body === 'object' && 'error' in body
        ? (body as { error: ConstructorParameters<typeof ApiError>[1] }).error
        : {};
    throw new ApiError(response.status, envelope);
  }

  return body as T;
}

export interface ApprovalRecord {
  id: string;
  postId: string;
  stage: ApprovalStage;
  state: ApprovalState;
  round: number;
  comment: string | null;
  onBehalfOf: boolean;
  requestedAt: string;
  decidedAt: string | null;
  requestedBy?: { id: string; name: string | null; email: string } | null;
  decidedBy?: { id: string; name: string | null; email: string } | null;
}

export interface QueueItem extends ApprovalRecord {
  post: {
    id: string;
    title: string | null;
    body: string;
    status: PostStatus;
    workspaceId: string;
    brandId: string;
    scheduledFor: string | null;
  };
}

export interface CommentRecord {
  id: string;
  postId: string;
  parentId: string | null;
  body: string;
  visibility: 'INTERNAL' | 'CLIENT_VISIBLE';
  resolvedAt: string | null;
  createdAt: string;
  author: { id: string; name: string | null; email: string; avatarUrl: string | null } | null;
}

export function approvalsApi(orgSlug: string) {
  const base = `/api/v1/orgs/${encodeURIComponent(orgSlug)}`;

  return {
    queue(params: { stage?: string; state?: string; workspaceId?: string } = {}) {
      const query = new URLSearchParams(
        Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1])),
      );
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return request<{ approvals: QueueItem[] }>(`${base}/approvals${suffix}`);
    },

    forPost(postId: string) {
      return request<{ approvals: ApprovalRecord[] }>(`${base}/posts/${postId}/approvals`);
    },

    decide(
      approvalId: string,
      input: {
        decision: ApprovalDecision;
        comment?: string;
        onBehalfOf?: boolean;
        reason?: string;
      },
    ) {
      return request<{ approvalId: string; decision: ApprovalDecision }>(
        `${base}/approvals/${approvalId}/decide`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    },

    comments(postId: string) {
      return request<{ comments: CommentRecord[] }>(`${base}/posts/${postId}/comments`);
    },

    comment(postId: string, input: { body: string; visibility?: string; parentId?: string }) {
      return request<{ comment: CommentRecord }>(`${base}/posts/${postId}/comments`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    resolve(commentId: string) {
      return request<{ comment: CommentRecord }>(`${base}/comments/${commentId}/resolve`, {
        method: 'POST',
      });
    },
  };
}

export { ApiError };
