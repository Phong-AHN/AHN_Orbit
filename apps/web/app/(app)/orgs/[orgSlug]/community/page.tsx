import type { Metadata } from 'next';
import Link from 'next/link';
import { clock } from '@orbit/core';
import { Card, CardBody, Empty, PageHeader, PermissionDenied, cn } from '@orbit/ui';
import { pageCanSomewhere, requirePageContext } from '@/server/page-context';
import { listCommentedPosts, unhandledCount } from '@/features/community/service';
import { PostCard } from '@/features/community/ui/post-card';
import { SyncButton } from '@/features/community/ui/sync-button';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Community' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * The community inbox, as a list of posts.
 *
 * ## Posts, not a flat queue of comments
 *
 * A comment means something only next to the post it answers. The first
 * version listed every comment from every post in one column, which read like
 * a log: "Is it still available?" with no way to tell *what* was available
 * without opening the post elsewhere. Both platforms present comments under
 * their post, and so does this — open a post to read and answer its thread.
 *
 * Ordered so the work comes first: a post with somebody waiting sorts above
 * one where everything is handled, however recent the latter. A queue sorted
 * purely by time buries a three-day-old unanswered question under a fresh post
 * everybody has already dealt with.
 *
 * ## Authorization
 *
 * `pageCanSomewhere` for the gate, because `comment:read_public` is
 * brand-scoped for a Content Creator and an Approver and an empty-resource
 * check would deny the people this screen is for (**D-069**). The service
 * then narrows the posts to the principal's reachable workspaces before
 * anything is counted.
 */
export default async function CommunityPage({ params, searchParams }: PageProps) {
  const { orgSlug } = await params;
  const query = await searchParams;

  const { ctx, organization } = await requirePageContext(orgSlug);

  if (!pageCanSomewhere(ctx, 'comment:read_public')) {
    return (
      <main id="main" className="px-4 py-10 sm:px-6">
        <PermissionDenied action="see the community inbox" />
      </main>
    );
  }

  // Default to what needs attention. An inbox that opens on everything ever
  // said is a report, not an inbox.
  const waitingOnly = query.view !== 'all';

  const [posts, unhandled] = await Promise.all([
    listCommentedPosts(ctx, { waitingOnly }),
    unhandledCount(ctx),
  ]);

  const canReply = pageCanSomewhere(ctx, 'comment:reply');
  const now = clock.now();

  return (
    <main id="main" className="px-4 py-10 sm:px-6">
      <PageHeader
        eyebrow={organization.name}
        title="Community"
        description={
          unhandled === 0
            ? 'Nothing waiting. Comments on published posts appear here.'
            : `${unhandled.toLocaleString()} ${unhandled === 1 ? 'comment' : 'comments'} waiting for a reply.`
        }
      />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <nav className="flex gap-1.5" aria-label="Filter posts">
          {(
            [
              ['waiting', 'Needs a reply'],
              ['all', 'All posts'],
            ] as const
          ).map(([value, label]) => {
            const active = (value === 'all') === !waitingOnly;
            return (
              <Link
                key={value}
                href={`/orgs/${orgSlug}/community${value === 'all' ? '?view=all' : ''}`}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'rounded px-2.5 py-1.5 text-sm transition-colors',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                  active
                    ? 'bg-accent-soft font-semibold text-accent'
                    : 'text-ink-secondary hover:bg-surface-sunken hover:text-ink',
                )}
              >
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Offered only to people who may reply: it spends the tenant's
            provider quota, which is not a control for someone only reading. */}
        {canReply ? <SyncButton orgSlug={orgSlug} /> : null}
      </div>

      {posts.length === 0 ? (
        <Card className="mt-6">
          <CardBody>
            <Empty
              title={waitingOnly ? 'Nothing waiting' : 'No comments yet'}
              description={
                waitingOnly
                  ? 'Every comment on your published posts has been handled.'
                  : 'Comments on posts published through Orbit are read back every few minutes and appear here. Comments on posts made outside Orbit are not collected.'
              }
            />
          </CardBody>
        </Card>
      ) : (
        <ul className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {posts.map((post) => (
            <PostCard
              key={post.id}
              orgSlug={orgSlug}
              now={now}
              post={post}
              summary={post.summary}
            />
          ))}
        </ul>
      )}

      {/* Said once, at the bottom, rather than on every card: the boundary is
          a property of the feature, not of any one post. */}
      <p className="mt-8 max-w-prose text-xs text-ink-muted">
        Orbit reads comments on posts it published. A post made directly on the platform has no
        client or brand to file its comments under, so it is not collected &mdash; and no
        commenter&rsquo;s identity is stored, only the public name shown beside what they wrote.
      </p>
    </main>
  );
}
