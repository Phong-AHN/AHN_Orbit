import type { Metadata } from 'next';
import Link from 'next/link';
import { SOCIAL_COMMENT_STATES, type SocialCommentState } from '@orbit/core';
import { Card, CardBody, Empty, PageHeader, PermissionDenied, cn } from '@orbit/ui';
import { pageCanSomewhere, requirePageContext } from '@/server/page-context';
import { listComments, unhandledCount } from '@/features/community/service';
import { listMembers } from '@/features/tenancy/members';
import { CommentRow } from '@/features/community/ui/comment-row';
import { SyncButton } from '@/features/community/ui/sync-button';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Community' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function isState(value: unknown): value is SocialCommentState {
  return typeof value === 'string' && (SOCIAL_COMMENT_STATES as readonly string[]).includes(value);
}

/**
 * The community inbox — what the audience said, and what needs answering.
 *
 * The one thing this product could not do before. Comments arrived on a
 * client's channel and the only way to see them was to open Facebook.
 *
 * ## Server-rendered, and the queue is narrowed rather than filtered
 *
 * The service scopes the *query* to what this principal may read, so what
 * arrives here is already theirs — there is no client-side filter standing
 * between a wider result and a narrower view. The same reason the approval
 * queue is built this way.
 *
 * ## `pageCanSomewhere` for the gate, `pageCan` for the action
 *
 * `comment:read_public` is brand-scoped for a Content Creator, so asking
 * `pageCan` with no resource would deny the people this screen is for
 * (**D-069**) — which is why `pageCanSomewhere` is used for both checks here.
 * The gate asks whether the inbox is part of their product at all;
 * whether they may *reply* is asked per row by the API, and the answer here
 * only decides whether to render a reply box that would be refused.
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

  // Default to what needs attention. A queue that opens showing everything
  // ever said is a report, not a queue.
  const state = isState(query.state) ? query.state : 'NEW';

  const [comments, unhandled, members] = await Promise.all([
    listComments(ctx, { state }),
    unhandledCount(ctx),
    // Only people who could actually act on an assignment. `listMembers`
    // returns clients too, and a comment assigned to a client would be a task
    // nobody can see — the service refuses it, so it is not offered either.
    listMembers(ctx).then((rows) =>
      rows
        .filter((member) => member.role !== 'CLIENT' && member.status === 'ACTIVE')
        .map((member) => ({
          id: member.user.id,
          name: member.user.name,
          email: member.user.email,
        })),
    ),
  ]);

  const canReply = pageCanSomewhere(ctx, 'comment:reply');

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
        <nav className="flex gap-1.5" aria-label="Filter by state">
          {(['NEW', 'HANDLED'] as const).map((value) => (
            <Link
              key={value}
              href={`/orgs/${orgSlug}/community?state=${value}`}
              aria-current={state === value ? 'page' : undefined}
              className={cn(
                'rounded px-2.5 py-1.5 text-sm transition-colors',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                state === value
                  ? 'bg-accent-soft font-semibold text-accent'
                  : 'text-ink-secondary hover:bg-surface-sunken hover:text-ink',
              )}
            >
              {value === 'NEW' ? 'Needs a reply' : 'Handled'}
            </Link>
          ))}
        </nav>

        {/* Beside the filters rather than in the header: it acts on the queue
            below, not on the page. Offered only to people who may reply — it
            spends the tenant's provider quota, so it is not a control to hand
            to somebody who is only reading. */}
        {canReply ? <SyncButton orgSlug={orgSlug} /> : null}
      </div>

      {comments.length === 0 ? (
        <Card className="mt-6">
          <CardBody>
            <Empty
              title={state === 'NEW' ? 'Nothing waiting' : 'Nothing handled yet'}
              description={
                state === 'NEW'
                  ? 'Comments on posts published through Orbit are read back every few minutes and appear here. Comments on posts made outside Orbit are not collected.'
                  : 'Comments the team has answered or dismissed will be listed here.'
              }
            />
          </CardBody>
        </Card>
      ) : (
        <ul className="mt-6 space-y-3">
          {comments.map((comment) => (
            <CommentRow
              key={comment.id}
              orgSlug={orgSlug}
              comment={{
                id: comment.id,
                authorName: comment.authorName,
                message: comment.message,
                permalink: comment.permalink,
                postedAt: comment.postedAt.toISOString(),
                state: comment.state,
                assignedTo: comment.assignedTo,
                socialAccount: comment.socialAccount,
                postVariant: comment.postVariant,
              }}
              members={members}
              canReply={canReply}
            />
          ))}
        </ul>
      )}

      {/* Said once, at the bottom, rather than on every row: the boundary is a
          property of the feature, not of any one comment. */}
      <p className="mt-8 max-w-prose text-xs text-ink-muted">
        Orbit reads comments on posts it published. A post made directly on the platform has no
        client or brand to file its comments under, so it is not collected — and no
        commenter&rsquo;s identity is stored, only the public name shown beside what they wrote.
      </p>
    </main>
  );
}
