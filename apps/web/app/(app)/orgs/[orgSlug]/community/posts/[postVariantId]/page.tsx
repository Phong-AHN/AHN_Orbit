import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ForbiddenError, NotFoundError, clock } from '@orbit/core';
import { PageHeader, PermissionDenied } from '@orbit/ui';
import { pageCanSomewhere, requirePageContext } from '@/server/page-context';
import { getPostThread } from '@/features/community/service';
import { listMembers } from '@/features/tenancy/members';
import { PostThread } from '@/features/community/ui/post-thread';
import { SyncButton } from '@/features/community/ui/sync-button';
import type { MediaItem } from '@/features/media/ui/media-panel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Post comments' };

interface PageProps {
  params: Promise<{ orgSlug: string; postVariantId: string }>;
}

/**
 * One post and the conversation under it.
 *
 * ## Not found and not allowed look the same from outside
 *
 * `getPostThread` throws `NotFoundError` for a post that does not exist or is
 * deleted, and `ForbiddenError` for one in a brand this principal cannot read.
 * Both render the same "not found" here. Telling a brand-scoped role that a
 * post exists in a brand they are not on is a leak of exactly the thing the
 * scoping exists to hide.
 */
export default async function PostCommentsPage({ params }: PageProps) {
  const { orgSlug, postVariantId } = await params;
  const { ctx, organization } = await requirePageContext(orgSlug);

  if (!pageCanSomewhere(ctx, 'comment:read_public')) {
    return (
      <main id="main" className="px-4 py-10 sm:px-6">
        <PermissionDenied action="see the community inbox" />
      </main>
    );
  }

  let thread: Awaited<ReturnType<typeof getPostThread>>;
  try {
    thread = await getPostThread(ctx, postVariantId);
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) notFound();
    throw error;
  }

  const { variant, comments } = thread;

  const members = (await listMembers(ctx))
    // Only people who could act on an assignment. A comment assigned to a
    // client is a task nobody can see, and the service refuses it.
    .filter((member) => member.role !== 'CLIENT' && member.status === 'ACTIVE')
    .map((member) => ({ id: member.user.id, name: member.user.name, email: member.user.email }));

  const canReply = pageCanSomewhere(ctx, 'comment:reply');

  const media: MediaItem[] = variant.post.media.map((attachment) => ({
    mediaAssetId: attachment.mediaAsset.id,
    kind: attachment.mediaAsset.kind,
    mimeType: attachment.mediaAsset.mimeType,
    altText: attachment.altText ?? '',
    ...(attachment.mediaAsset.width ? { width: attachment.mediaAsset.width } : {}),
    ...(attachment.mediaAsset.height ? { height: attachment.mediaAsset.height } : {}),
    ...(attachment.mediaAsset.durationMs ? { durationMs: attachment.mediaAsset.durationMs } : {}),
  }));

  return (
    <main id="main" className="px-4 py-10 sm:px-6">
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
        <Link
          href={`/orgs/${orgSlug}/community`}
          className="text-ink-secondary underline-offset-2 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          &larr; Community
        </Link>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          eyebrow={organization.name}
          title={variant.post.title ?? 'Post comments'}
          description={`On ${variant.socialAccount.displayName}`}
        />
        {canReply ? <SyncButton orgSlug={orgSlug} /> : null}
      </div>

      <div className="mt-6">
        <PostThread
          orgSlug={orgSlug}
          renderedAt={clock.now().toISOString()}
          canReply={canReply}
          members={members}
          post={{
            platform: variant.platform,
            body: variant.body,
            hashtags: variant.hashtags,
            publishedAt: variant.publishedAt?.toISOString() ?? null,
            externalPermalink: variant.externalPermalink,
            account: {
              displayName: variant.socialAccount.displayName,
              handle: variant.socialAccount.handle,
              avatarUrl: variant.socialAccount.avatarUrl,
            },
            media,
          }}
          comments={comments.map((comment) => ({
            id: comment.id,
            externalId: comment.externalId,
            parentExternalId: comment.parentExternalId,
            origin: comment.origin,
            state: comment.state,
            authorName: comment.authorName,
            message: comment.message,
            postedAt: comment.postedAt.toISOString(),
            assignedTo: comment.assignedTo,
          }))}
        />
      </div>
    </main>
  );
}
