import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ForbiddenError, NotFoundError, clock } from '@orbit/core';
import { PageHeader, PermissionDenied } from '@orbit/ui';
import { pageCan, pageCanSomewhere, requirePageContext } from '@/server/page-context';
import { ensureProvidersRegistered } from '@/server/providers';
import { listMembers } from '@/features/tenancy/members';
import { participantLabel } from '@/features/messaging/inbox';
import { getConversation, messagingAvailable } from '@/features/messaging/service';
import { ConversationThread } from '@/features/messaging/ui/conversation-thread';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Conversation' };

interface PageProps {
  params: Promise<{ orgSlug: string; conversationId: string }>;
}

/**
 * One private conversation (**D-107**).
 *
 * Not found and not allowed render the same, as on the comment thread: telling
 * a brand-scoped role that a conversation exists in a brand they are not on is
 * a leak of exactly what the scoping hides.
 */
export default async function ConversationPage({ params }: PageProps) {
  const { orgSlug, conversationId } = await params;
  const { ctx, organization } = await requirePageContext(orgSlug);

  ensureProvidersRegistered();
  if (!messagingAvailable()) notFound();

  if (!pageCanSomewhere(ctx, 'message:read')) {
    return (
      <main id="main" className="px-4 py-10 sm:px-6">
        <PermissionDenied action="see messages" />
      </main>
    );
  }

  let loaded: Awaited<ReturnType<typeof getConversation>>;
  try {
    loaded = await getConversation(ctx, conversationId);
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) notFound();
    throw error;
  }

  const { conversation, messages, window } = loaded;

  const members = (await listMembers(ctx))
    .filter((member) => member.role !== 'CLIENT' && member.status === 'ACTIVE')
    .map((member) => ({ id: member.user.id, name: member.user.name, email: member.user.email }));

  return (
    <main id="main" className="px-4 py-10 sm:px-6">
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
        <Link
          href={`/orgs/${orgSlug}/community/messages`}
          className="text-ink-secondary underline-offset-2 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          &larr; Messages
        </Link>
      </nav>

      <PageHeader
        eyebrow={organization.name}
        title={participantLabel(conversation)}
        description={`Private conversation with ${conversation.socialAccount.displayName}`}
      />

      <div className="mt-6 max-w-3xl">
        <ConversationThread
          orgSlug={orgSlug}
          renderedAt={clock.now().toISOString()}
          // Against this conversation's own brand: `message:reply` is
          // brand-scoped for a Content Creator. The server checks again.
          canReply={pageCan(ctx, 'message:reply', {
            workspaceId: conversation.workspaceId,
            brandId: conversation.brandId,
          })}
          members={members}
          conversation={{
            id: conversation.id,
            state: conversation.state,
            participantName: conversation.participantName,
            participantUsername: conversation.participantUsername,
            assignedTo: conversation.assignedTo,
            account: {
              displayName: conversation.socialAccount.displayName,
              platform: conversation.socialAccount.platform,
              avatarUrl: conversation.socialAccount.avatarUrl,
            },
          }}
          messages={messages.map((message) => ({
            id: message.id,
            direction: message.direction,
            text: message.text,
            attachments: message.attachments,
            sentAt: message.sentAt.toISOString(),
            deletedAt: message.deletedAt?.toISOString() ?? null,
            createdBy: message.createdBy,
          }))}
          window={{ state: window.state, closesAt: window.closesAt?.toISOString() ?? null }}
          needsReconnect={loaded.needsReconnect}
          maxMessageLength={loaded.maxMessageLength}
        />
      </div>
    </main>
  );
}
