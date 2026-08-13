import type { Metadata } from 'next';
import { Badge, Card, CardBody, CardHeader, CardTitle, PageHeader } from '@orbit/ui';
import { requirePortalContext } from '@/server/portal-context';
import { getPortalPost } from '@/features/portal/service';
import { CommentBox } from '@/features/portal/ui/comment-box';
import { DecisionPanel } from '@/features/portal/ui/decision-panel';
import { clientStatusLabel, clientStatusTone } from '@/features/portal/ui/status';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Review' };

interface PageProps {
  params: Promise<{ workspaceId: string; postId: string }>;
}

/**
 * One post, as the client reviews it (SRS §21).
 *
 * The page shows what will actually go out — per platform, with the images —
 * because that is what they are being asked to approve. `getPortalPost` throws
 * a `NotFoundError` for anything not theirs or not yet theirs, which the route
 * group's `not-found` boundary renders.
 */
export default async function PortalPostPage({ params }: PageProps) {
  const { workspaceId, postId } = await params;
  const { ctx, workspace } = await requirePortalContext(workspaceId);

  const { post, media, comments, approval } = await getPortalPost(ctx, workspaceId, postId);

  const awaitingDecision = post.status === 'CLIENT_REVIEW' && approval?.state === 'PENDING';

  return (
    <main id="main" className="mx-auto max-w-3xl space-y-6 px-6 py-10">
      <PageHeader
        eyebrow={workspace.name}
        title={post.title ?? 'Your post'}
        description={
          post.scheduledFor
            ? `Planned for ${formatWhen(post.scheduledFor, post.timezone)}`
            : 'Not scheduled yet'
        }
      />

      <div>
        <Badge tone={clientStatusTone(post.status)}>{clientStatusLabel(post.status)}</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>The post</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <p className="whitespace-pre-wrap text-sm text-ink">{post.body}</p>

          {media.length > 0 ? (
            <ul className="grid grid-cols-2 gap-3">
              {media.map((item) => (
                <li key={item.asset.id}>
                  {/*
                   * A plain <img>, not next/image. The source is a signed URL
                   * that expires in fifteen minutes; putting it behind the image
                   * optimizer would mean caching a credential-bearing URL and
                   * configuring a remote pattern for the whole bucket.
                   */}
                  <img
                    src={item.url}
                    alt={item.altText ?? ''}
                    className="w-full rounded-lg border border-line object-cover"
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </CardBody>
      </Card>

      {post.variants.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>How it will look on each account</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            {post.variants.map((variant) => (
              <div key={variant.id} className="rounded-lg border border-line px-3 py-2.5">
                <p className="text-xs font-medium text-ink-muted">
                  {variant.socialAccount.displayName} · {variant.platform}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-ink">
                  {variant.body.trim().length > 0 ? variant.body : post.body}
                </p>
                {variant.hashtags.length > 0 ? (
                  <p className="mt-1 text-xs text-accent">
                    {variant.hashtags.map((tag) => `#${tag}`).join(' ')}
                  </p>
                ) : null}
                {variant.externalPermalink ? (
                  <a
                    href={variant.externalPermalink}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-1.5 inline-block text-xs text-accent hover:underline"
                  >
                    See it live →
                  </a>
                ) : null}
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <DecisionPanel postId={postId} awaitingDecision={awaitingDecision} />

      <Card>
        <CardHeader>
          <CardTitle>Notes</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          {comments.length === 0 ? (
            <p className="text-sm text-ink-muted">No notes yet.</p>
          ) : (
            <ul className="space-y-3">
              {comments.map((comment) => (
                <li key={comment.id}>
                  <p className="text-xs font-medium text-ink-muted">
                    {comment.author?.name ?? 'Your team'}
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink">{comment.body}</p>
                </li>
              ))}
            </ul>
          )}

          <CommentBox postId={postId} />
        </CardBody>
      </Card>
    </main>
  );
}

/** The client's own timezone, which is the workspace's (assumption C5). */
function formatWhen(value: Date, timezone: string | null): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone ?? 'UTC',
  }).format(value);
}
