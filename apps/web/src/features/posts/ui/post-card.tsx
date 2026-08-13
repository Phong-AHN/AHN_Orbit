import Link from 'next/link';
import type { PostStatus } from '@orbit/core';
import { Badge, Card, CardBody, cn } from '@orbit/ui';
import { STATUS_LABEL, STATUS_TONE } from './status';

/**
 * One row in the post list. A server component — it renders from data the page
 * already resolved, so the list needs no client bundle at all.
 */

export interface PostCardProps {
  orgSlug: string;
  post: {
    id: string;
    title: string | null;
    body: string;
    status: PostStatus;
    scheduledFor: Date | null;
    updatedAt: Date;
    variants: Array<{ id: string; platform: string; status: string }>;
  };
}

export function PostCard({ orgSlug, post }: PostCardProps) {
  const preview = post.body.trim().slice(0, 160);
  const platforms = [...new Set(post.variants.map((v) => v.platform))];

  return (
    <Card className="transition-colors hover:border-line-strong">
      <CardBody>
        <Link href={`/orgs/${orgSlug}/posts/${post.id}`} className="block focus:outline-none">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
              {post.title ?? preview.slice(0, 60) ?? 'Untitled post'}
            </h3>
            <Badge tone={STATUS_TONE[post.status]}>{STATUS_LABEL[post.status]}</Badge>
          </div>

          {preview ? (
            <p className="mt-1.5 line-clamp-2 text-sm text-ink-muted">{preview}</p>
          ) : (
            <p className="mt-1.5 text-sm italic text-ink-muted">No text yet</p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
            <span className={cn(platforms.length === 0 && 'text-warning')}>
              {platforms.length === 0
                ? 'No accounts selected'
                : platforms.map((p) => p.toLowerCase()).join(' · ')}
            </span>
            {post.scheduledFor ? (
              <time dateTime={post.scheduledFor.toISOString()}>
                Scheduled {post.scheduledFor.toISOString().slice(0, 16).replace('T', ' ')}
              </time>
            ) : (
              <time dateTime={post.updatedAt.toISOString()}>
                Edited {post.updatedAt.toISOString().slice(0, 10)}
              </time>
            )}
          </div>
        </Link>
      </CardBody>
    </Card>
  );
}
