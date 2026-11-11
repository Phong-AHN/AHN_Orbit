import type { Metadata } from 'next';
import { accessibleWorkspaceIds, isUserPrincipal, PLATFORMS, POST_STATUSES } from '@orbit/core';
import { CLIENT_VISIBLE_STATUSES } from '@orbit/rbac';
import Link from 'next/link';
import { Empty, PageHeader, PermissionDenied, buttonClassName } from '@orbit/ui';
import { pageCan, requirePageContext } from '@/server/page-context';
import { listPostFilterOptions, listPosts } from '@/features/posts/service';
import {
  isFiltered,
  POST_SORT_LABEL,
  POST_SORTS,
  readPostListParams,
} from '@/features/posts/list-query';
import { PostCard } from '@/features/posts/ui/post-card';
import { PostListFilters } from '@/features/posts/ui/post-list-filters';
import { STATUS_LABEL } from '@/features/posts/ui/status';
import { platformName } from '@/features/publishing/ui/links';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Posts' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** How many posts one page shows. A filter is how to reach the rest. */
const LIST_LIMIT = 100;

/**
 * The post list, with search, filters and sort.
 *
 * Rendered entirely on the server: the data is already behind the tenant-scoped
 * client, so shipping it as HTML avoids a second round trip. The filter bar is
 * a GET form, so every view of the list is a URL.
 */
export default async function PostsPage({ params, searchParams }: PageProps) {
  const { orgSlug } = await params;
  const list = readPostListParams(await searchParams);

  const { ctx, organization } = await requirePageContext(orgSlug);

  if (
    !pageCan(ctx, 'post:read', {
      ...(list.workspaceId ? { workspaceId: list.workspaceId } : {}),
      ...(list.brandId ? { brandId: list.brandId } : {}),
    })
  ) {
    return (
      <main id="main" className="px-4 py-10 sm:px-6">
        <PermissionDenied action="see posts here" />
      </main>
    );
  }

  const isClient = isUserPrincipal(ctx.principal) && ctx.principal.organizationRole === 'CLIENT';
  const accessible = accessibleWorkspaceIds(ctx);

  const [posts, brands] = await Promise.all([
    listPosts(ctx, {
      ...list,
      ...(isClient ? { visibleStatuses: CLIENT_VISIBLE_STATUSES } : {}),
      accessibleWorkspaces: accessible,
      limit: LIST_LIMIT,
    }),
    listPostFilterOptions(ctx, accessible),
  ]);

  // A Client is offered only the statuses they can ever see.
  const statuses = isClient ? CLIENT_VISIBLE_STATUSES : POST_STATUSES;
  const clients = [
    ...new Map(brands.map((brand) => [brand.workspace.id, brand.workspace.name])).entries(),
  ].map(([value, label]) => ({ value, label }));

  const filtered = isFiltered(list);
  const action = `/orgs/${orgSlug}/posts`;
  const values = {
    q: list.search,
    status: list.status,
    platform: list.platform,
    workspaceId: list.workspaceId,
    brandId: list.brandId,
    sort: list.sort,
  };

  return (
    <main id="main" className="px-4 py-10 sm:px-6">
      <PageHeader
        eyebrow={organization.name}
        title="Posts"
        description="Everything in flight — drafts, reviews, scheduled and published."
        actions={
          pageCan(ctx, 'post:create') ? (
            <Link href={`/orgs/${orgSlug}/posts/new`} className={buttonClassName({ size: 'sm' })}>
              New post
            </Link>
          ) : null
        }
      />

      <div className="mt-6">
        <PostListFilters
          // Remounted when the URL changes, so "Clear" and the back button
          // show the values the list was actually built from.
          key={JSON.stringify(values)}
          action={action}
          values={values}
          statuses={statuses.map((status) => ({ value: status, label: STATUS_LABEL[status] }))}
          platforms={PLATFORMS.map((platform) => ({
            value: platform,
            label: platformName(platform),
          }))}
          sorts={POST_SORTS.map((sort) => ({ value: sort, label: POST_SORT_LABEL[sort] }))}
          clients={clients}
          brands={brands.map((brand) => ({
            value: brand.id,
            label: brand.name,
            workspaceId: brand.workspace.id,
            clientName: brand.workspace.name,
          }))}
          filtered={filtered}
        />
      </div>

      {posts.length === 0 ? (
        filtered ? (
          <Empty
            className="mt-8"
            title="No posts match"
            description="Nothing fits this search and these filters. Try fewer filters, or clear them."
            action={
              <Link href={action} className={buttonClassName()}>
                Clear filters
              </Link>
            }
          />
        ) : (
          <Empty
            className="mt-8"
            title="Nothing here yet"
            description={
              isClient
                ? 'When your agency sends something for review, it will appear here.'
                : 'Create a post to get started. You can pick the accounts it goes to as you write.'
            }
            action={
              pageCan(ctx, 'post:create') ? (
                <Link href={`/orgs/${orgSlug}/posts/new`} className={buttonClassName()}>
                  New post
                </Link>
              ) : null
            }
          />
        )
      ) : (
        <>
          <p className="mt-6 text-sm text-ink-muted" aria-live="polite">
            {posts.length === LIST_LIMIT
              ? `Showing the first ${LIST_LIMIT} posts. Search or filter to find the rest.`
              : `${posts.length} post${posts.length === 1 ? '' : 's'}${filtered ? ' match' : ''}`}
          </p>
          <ul className="mt-3 space-y-3">
            {posts.map((post) => (
              <li key={post.id}>
                <PostCard orgSlug={orgSlug} post={post} />
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
