import Link from 'next/link';
import { Badge, cn } from '@orbit/ui';
import { compactAge, type PostSummary } from '../thread';

/**
 * One post in the inbox, with how much its audience said.
 *
 * A server component: everything it shows is already in the row, and a list
 * of cards has no reason to ship JavaScript. The thumbnail is left to the
 * thread view, where the signed URL is worth fetching — a grid of posts each
 * requesting a fresh signed URL on every render is a cost with no reader.
 */
export interface PostCardProps {
  orgSlug: string;
  now: Date;
  post: {
    id: string;
    platform: string;
    body: string;
    publishedAt: Date | null;
    socialAccount: { displayName: string; handle: string | null };
    post: { title: string | null };
  };
  summary: PostSummary;
}

export function PostCard({ orgSlug, now, post, summary }: PostCardProps) {
  const waiting = summary.needsReply > 0;
  const excerpt = post.body.trim() || post.post.title || 'Untitled post';

  return (
    <li>
      <Link
        href={`/orgs/${orgSlug}/community/posts/${post.id}`}
        className={cn(
          'block rounded-lg border bg-surface p-4 transition-colors',
          'hover:bg-surface-sunken',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          // A post with somebody waiting is the one to open first; the border
          // says so without relying on colour alone — the badge says it too.
          waiting ? 'border-warning' : 'border-line',
        )}
      >
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-ink">
            {post.socialAccount.displayName}
          </span>
          <Badge tone="neutral">{post.platform.toLowerCase()}</Badge>
          {post.publishedAt ? (
            <time
              dateTime={post.publishedAt.toISOString()}
              className="ml-auto shrink-0 text-xs text-ink-muted"
            >
              {compactAge(post.publishedAt, now)}
            </time>
          ) : null}
        </div>

        <p className="mt-2 line-clamp-2 text-sm text-ink-secondary">{excerpt}</p>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <span>
            {summary.audience.toLocaleString()} {summary.audience === 1 ? 'comment' : 'comments'}
          </span>
          {waiting ? (
            <Badge tone="warning">
              {summary.needsReply.toLocaleString()} {summary.needsReply === 1 ? 'needs' : 'need'} a
              reply
            </Badge>
          ) : (
            <Badge tone="success">All handled</Badge>
          )}
        </div>
      </Link>
    </li>
  );
}
