import { isUuid, PLATFORMS, POST_STATUSES, type Platform, type PostStatus } from '@orbit/core';
import type { Prisma } from '@orbit/db';

/**
 * Search, filter and sort for the post list — the page and the API read the
 * same parameters through `readPostListParams`.
 *
 * Every value arrives from a URL, so each is checked against what it can be
 * and dropped when it is not. An id that is not a UUID is dropped rather than
 * passed on, because the database rejects it outright and the list would fail
 * with an error instead of showing nothing.
 */

export const POST_SORTS = ['upcoming', 'newest', 'oldest', 'updated', 'published'] as const;
export type PostSort = (typeof POST_SORTS)[number];

export const POST_SORT_LABEL: Record<PostSort, string> = {
  upcoming: 'Scheduled soonest',
  newest: 'Newest first',
  oldest: 'Oldest first',
  updated: 'Recently edited',
  published: 'Recently published',
};

/** Long enough for a phrase; short enough that nobody pastes a whole post. */
export const SEARCH_MAX_LENGTH = 100;

export interface PostListParams {
  search?: string;
  status?: PostStatus;
  platform?: Platform;
  workspaceId?: string;
  brandId?: string;
  sort: PostSort;
}

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;

function read(source: ParamSource, key: string): string | undefined {
  if (source instanceof URLSearchParams) return source.get(key) ?? undefined;
  const value = source[key];
  return Array.isArray(value) ? value[0] : value;
}

export function readPostListParams(source: ParamSource): PostListParams {
  const search = read(source, 'q')?.trim().slice(0, SEARCH_MAX_LENGTH);
  const status = read(source, 'status');
  const platform = read(source, 'platform');
  const workspaceId = read(source, 'workspaceId');
  const brandId = read(source, 'brandId');
  const sort = read(source, 'sort');

  return {
    ...(search ? { search } : {}),
    ...(status && (POST_STATUSES as readonly string[]).includes(status)
      ? { status: status as PostStatus }
      : {}),
    ...(platform && (PLATFORMS as readonly string[]).includes(platform)
      ? { platform: platform as Platform }
      : {}),
    ...(workspaceId && isUuid(workspaceId) ? { workspaceId } : {}),
    ...(brandId && isUuid(brandId) ? { brandId } : {}),
    sort:
      sort && (POST_SORTS as readonly string[]).includes(sort) ? (sort as PostSort) : 'upcoming',
  };
}

/** Whether anything narrows the list, which changes what an empty list means. */
export function isFiltered(params: PostListParams): boolean {
  return Boolean(
    params.search || params.status || params.platform || params.workspaceId || params.brandId,
  );
}

export interface PostListScope {
  /** The workspaces this viewer may see, from their grant — never from the request. */
  accessibleWorkspaces?: 'ALL' | readonly string[];
  /** A Client's permitted statuses, from the RBAC matrix. */
  visibleStatuses?: readonly PostStatus[];
}

/** Matches nothing. Used where a filter asks for something outside the viewer's reach. */
const NOTHING: Prisma.PostWhereInput = { id: { in: [] } };

/**
 * The `where` for a list, with every condition ANDed.
 *
 * ANDed on purpose. The previous version spread the conditions into one
 * object, so the access rule silently replaced the request's own filter on the
 * same field: a person with access to some clients who picked one still saw
 * all of them, and a Client's status filter was ignored.
 */
export function postListWhere(
  params: Omit<PostListParams, 'sort'>,
  scope: PostListScope = {},
): Prisma.PostWhereInput {
  const and: Prisma.PostWhereInput[] = [{ deletedAt: null }];

  if (scope.accessibleWorkspaces && scope.accessibleWorkspaces !== 'ALL') {
    and.push({ workspaceId: { in: [...scope.accessibleWorkspaces] } });
  }
  if (params.workspaceId) and.push({ workspaceId: params.workspaceId });
  if (params.brandId) and.push({ brandId: params.brandId });

  if (scope.visibleStatuses) {
    and.push({ status: { in: [...scope.visibleStatuses] } });
  }
  if (params.status) {
    and.push(
      scope.visibleStatuses && !scope.visibleStatuses.includes(params.status)
        ? NOTHING
        : { status: params.status },
    );
  }

  if (params.platform) {
    and.push({ variants: { some: { platform: params.platform, deletedAt: null } } });
  }

  if (params.search) {
    and.push({
      OR: [
        { title: { contains: params.search, mode: 'insensitive' } },
        { body: { contains: params.search, mode: 'insensitive' } },
      ],
    });
  }

  return { AND: and };
}

/** The order for a sort, always ending on the id so equal rows keep their place. */
export function postListOrder(sort: PostSort): Prisma.PostOrderByWithRelationInput[] {
  switch (sort) {
    case 'newest':
      return [{ createdAt: 'desc' }, { id: 'desc' }];
    case 'oldest':
      return [{ createdAt: 'asc' }, { id: 'asc' }];
    case 'updated':
      return [{ updatedAt: 'desc' }, { id: 'desc' }];
    case 'published':
      return [
        { publishedAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
        { id: 'desc' },
      ];
    case 'upcoming':
    default:
      return [
        { scheduledFor: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'desc' },
        { id: 'desc' },
      ];
  }
}
