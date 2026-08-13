import type { Metadata } from 'next';
import {
  accessibleWorkspaceIds,
  isUserPrincipal,
  POST_STATUSES,
  type PostStatus,
} from '@orbit/core';
import { CLIENT_VISIBLE_STATUSES } from '@orbit/rbac';
import { Empty, PageHeader, PermissionDenied } from '@orbit/ui';
import { pageCan, requirePageContext } from '@/server/page-context';
import { listPosts } from '@/features/posts/service';
import { PostCard } from '@/features/posts/ui/post-card';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Posts' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readParam(
  values: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = values[key];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The post list.
 *
 * Rendered entirely on the server: the data is already behind the tenant-scoped
 * client, so shipping it as HTML avoids both a client bundle and a second
 * round trip. Only the composer needs interactivity.
 */
export default async function PostsPage({ params, searchParams }: PageProps) {
  const { orgSlug } = await params;
  const query = await searchParams;

  const { ctx, organization } = await requirePageContext(orgSlug);

  const workspaceId = readParam(query, 'workspaceId');
  const brandId = readParam(query, 'brandId');
  const status = readParam(query, 'status');

  if (
    !pageCan(ctx, 'post:read', {
      ...(workspaceId ? { workspaceId } : {}),
      ...(brandId ? { brandId } : {}),
    })
  ) {
    return (
      <main id="main" className="mx-auto max-w-5xl px-6 py-10">
        <PermissionDenied action="see posts here" />
      </main>
    );
  }

  const isClient = isUserPrincipal(ctx.principal) && ctx.principal.organizationRole === 'CLIENT';

  const posts = await listPosts(ctx, {
    ...(workspaceId ? { workspaceId } : {}),
    ...(brandId ? { brandId } : {}),
    ...(status && (POST_STATUSES as readonly string[]).includes(status)
      ? { status: status as PostStatus }
      : {}),
    ...(isClient ? { visibleStatuses: CLIENT_VISIBLE_STATUSES } : {}),
    accessibleWorkspaces: accessibleWorkspaceIds(ctx),
  });

  return (
    <main id="main" className="mx-auto max-w-5xl px-6 py-10">
      <PageHeader
        eyebrow={organization.name}
        title="Posts"
        description="Everything in flight — drafts, reviews, scheduled and published."
      />

      {posts.length === 0 ? (
        <Empty
          className="mt-8"
          title="Nothing here yet"
          description={
            isClient
              ? 'When your agency sends something for review, it will appear here.'
              : 'Create a post to get started. You can pick the accounts it goes to as you write.'
          }
        />
      ) : (
        <ul className="mt-8 space-y-3">
          {posts.map((post) => (
            <li key={post.id}>
              <PostCard orgSlug={orgSlug} post={post} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
