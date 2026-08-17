'use client';

import type { PostStatus } from '@orbit/core';

/**
 * Browser-side client for the post API.
 *
 * Every call goes through `apiRequest()`, which turns the error envelope
 * (docs/API.md §1) into a typed `ApiError`. The UI therefore never has to read
 * a raw response, and never has a reason to render `error.message` from an
 * unknown shape — `userMessage` from the envelope is already safe to show,
 * and `correlationId` is what a user quotes to support.
 */

export interface ApiErrorDetail {
  field: string;
  issue: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ApiErrorDetail[];
  readonly retryable: boolean;
  readonly correlationId: string | undefined;

  constructor(
    status: number,
    body: {
      code?: string;
      message?: string;
      details?: ApiErrorDetail[];
      retryable?: boolean;
      correlationId?: string;
    },
  ) {
    super(body.message ?? 'The action could not be completed.');
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code ?? 'INTERNAL_ERROR';
    this.details = body.details ?? [];
    this.retryable = body.retryable ?? false;
    this.correlationId = body.correlationId;
  }

  /** A 403 is rendered as a permission state rather than an error state. */
  get isPermissionDenied(): boolean {
    return this.status === 403;
  }
}

/**
 * Shared by every browser-side caller, not only posts.
 *
 * `ApiError` was already being imported from here by other features, so the
 * envelope handling is exported alongside it rather than copied — one place
 * that knows what the error envelope looks like (docs/API.md §1).
 */
export async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
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

// ── Shapes returned by the API ──────────────────────────────────────────────

export interface PostVariantSummary {
  id: string;
  socialAccountId: string;
  platform: string;
  body: string;
  linkUrl: string | null;
  hashtags: string[];
  firstComment: string | null;
  status: string;
  externalPermalink: string | null;
  /** Per-platform settings, opaque here. Only the platform's own panel reads them. */
  platformOptions?: Record<string, unknown> | null;
  socialAccount: { id: string; displayName: string; handle: string | null; status: string };
}

export interface PostDetail {
  id: string;
  title: string | null;
  body: string;
  status: PostStatus;
  workspaceId: string;
  brandId: string;
  createdById: string | null;
  assignedToId: string | null;
  approvalRequired: boolean;
  scheduledFor: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  variants: PostVariantSummary[];
  media: Array<{
    position: number;
    altText: string | null;
    mediaAsset: {
      id: string;
      kind: string;
      mimeType: string;
      width: number | null;
      height: number | null;
    };
  }>;
}

export interface PostListItem {
  id: string;
  title: string | null;
  body: string;
  status: PostStatus;
  workspaceId: string;
  brandId: string;
  createdById: string | null;
  assignedToId: string | null;
  scheduledFor: string | null;
  publishedAt: string | null;
  updatedAt: string;
  variants: Array<{ id: string; platform: string; status: string; socialAccountId: string }>;
}

export interface ValidationIssue {
  severity: 'ERROR' | 'WARNING';
  code: string;
  field: string;
  message: string;
}

export interface PostValidationResponse {
  valid: boolean;
  postIssues: ValidationIssue[];
  variants: Array<{
    variantId: string;
    socialAccountId: string;
    accountName: string;
    platform: string;
    result: { valid: boolean; issues: ValidationIssue[] };
  }>;
}

// ── Calls ───────────────────────────────────────────────────────────────────

export function postsApi(orgSlug: string) {
  const base = `/api/v1/orgs/${encodeURIComponent(orgSlug)}/posts`;

  return {
    list(params: { workspaceId?: string; brandId?: string; status?: string } = {}) {
      const query = new URLSearchParams(
        Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1])),
      );
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return apiRequest<{ posts: PostListItem[] }>(`${base}${suffix}`);
    },

    get(postId: string) {
      return apiRequest<{ post: PostDetail }>(`${base}/${postId}`);
    },

    create(input: Record<string, unknown>) {
      return apiRequest<{ post: PostDetail }>(base, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    update(postId: string, input: Record<string, unknown>) {
      return apiRequest<{ post: PostDetail }>(`${base}/${postId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
    },

    /** Returns the new `updatedAt` to carry into the next autosave. */
    autosave(postId: string, input: Record<string, unknown>) {
      return apiRequest<{ id: string; updatedAt: string }>(`${base}/${postId}/autosave`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    updateVariant(postId: string, variantId: string, input: Record<string, unknown>) {
      return apiRequest<{ variant: PostVariantSummary }>(
        `${base}/${postId}/variants/${variantId}`,
        {
          method: 'PATCH',
          body: JSON.stringify(input),
        },
      );
    },

    validate(postId: string) {
      return apiRequest<PostValidationResponse>(`${base}/${postId}/validate`, { method: 'POST' });
    },

    transition(postId: string, to: PostStatus, comment?: string) {
      return apiRequest<{ post: PostDetail }>(`${base}/${postId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ to, ...(comment ? { comment } : {}) }),
      });
    },

    duplicate(postId: string) {
      return apiRequest<{ post: PostDetail }>(`${base}/${postId}/duplicate`, { method: 'POST' });
    },

    assign(postId: string, assignedToId: string | null) {
      return apiRequest<{ post: PostDetail }>(`${base}/${postId}/assign`, {
        method: 'POST',
        body: JSON.stringify({ assignedToId }),
      });
    },

    remove(postId: string) {
      return apiRequest<void>(`${base}/${postId}`, { method: 'DELETE' });
    },
  };
}
