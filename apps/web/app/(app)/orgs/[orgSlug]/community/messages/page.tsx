import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { clock } from '@orbit/core';
import { Badge, Card, CardBody, Empty, PageHeader, PermissionDenied, cn } from '@orbit/ui';
import { pageCanSomewhere, requirePageContext } from '@/server/page-context';
import { ensureProvidersRegistered } from '@/server/providers';
import { compactAge } from '@/features/community/thread';
import { participantLabel, previewLine, windowLabel } from '@/features/messaging/inbox';
import {
  listConversations,
  messagingAvailable,
  waitingConversationCount,
} from '@/features/messaging/service';
import { InboxTabs } from '@/features/messaging/ui/inbox-tabs';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Messages' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Private conversations with the people who wrote to a client's Page or
 * Instagram account (**D-107**).
 *
 * Ordered so the work comes first, like the comment inbox: waiting
 * conversations above handled ones, most recent first within each. Each row
 * says how long is left to answer, because on these platforms a reply that
 * comes too late is not a late reply — it is one the platform refuses.
 *
 * `pageCanSomewhere` for the gate (`message:read` is brand-scoped for two
 * roles); the service narrows the rows to the principal's workspaces.
 */
export default async function MessagesPage({ params, searchParams }: PageProps) {
  const { orgSlug } = await params;
  const query = await searchParams;
  const { ctx, organization } = await requirePageContext(orgSlug);

  ensureProvidersRegistered();
  // A deployment without messaging has no such page, rather than an empty one.
  if (!messagingAvailable()) notFound();

  if (!pageCanSomewhere(ctx, 'message:read')) {
    return (
      <main id="main" className="px-4 py-10 sm:px-6">
        <PermissionDenied action="see messages" />
      </main>
    );
  }

  const waitingOnly = query.view !== 'all';
  const [conversations, waiting] = await Promise.all([
    listConversations(ctx, { waitingOnly }),
    waitingConversationCount(ctx),
  ]);
  const now = clock.now();

  return (
    <main id="main" className="px-4 py-10 sm:px-6">
      <PageHeader
        eyebrow={organization.name}
        title="Community"
        description={
          waiting === 0
            ? 'No conversation is waiting for a reply.'
            : `${waiting.toLocaleString()} ${waiting === 1 ? 'conversation is' : 'conversations are'} waiting for a reply.`
        }
      />

      <InboxTabs orgSlug={orgSlug} active="messages" waitingMessages={waiting} />

      <nav className="mt-4 flex gap-1.5" aria-label="Filter conversations">
        {(
          [
            ['waiting', 'Needs a reply'],
            ['all', 'All conversations'],
          ] as const
        ).map(([value, label]) => {
          const active = (value === 'all') === !waitingOnly;
          return (
            <Link
              key={value}
              href={`/orgs/${orgSlug}/community/messages${value === 'all' ? '?view=all' : ''}`}
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

      {conversations.length === 0 ? (
        <Card className="mt-6">
          <CardBody>
            <Empty
              title={waitingOnly ? 'Nothing waiting' : 'No conversations yet'}
              description={
                waitingOnly
                  ? 'Every conversation has been answered or marked handled.'
                  : 'Messages people send to connected Facebook Pages and Instagram accounts appear here.'
              }
            />
          </CardBody>
        </Card>
      ) : (
        <ul className="mt-6 divide-y divide-line rounded-lg border border-line bg-surface">
          {conversations.map((conversation) => {
            const deadline = windowLabel(
              {
                state: conversation.window.state,
                closesAt: conversation.window.closesAt?.toISOString() ?? null,
              },
              now,
            );
            const waitingOnUs = conversation.state === 'NEW';

            return (
              <li key={conversation.id}>
                <Link
                  href={`/orgs/${orgSlug}/community/messages/${conversation.id}`}
                  className="flex items-start gap-3 px-4 py-3 hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <p
                        className={cn(
                          'truncate text-sm text-ink',
                          waitingOnUs ? 'font-semibold' : null,
                        )}
                      >
                        {participantLabel(conversation)}
                      </p>
                      <time
                        dateTime={conversation.lastMessageAt.toISOString()}
                        className="shrink-0 text-xs text-ink-muted"
                      >
                        {compactAge(conversation.lastMessageAt, now)}
                      </time>
                    </div>
                    <p className="truncate text-sm text-ink-secondary">
                      {previewLine(conversation.lastMessage)}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                      <span>{conversation.socialAccount.displayName}</span>
                      {waitingOnUs ? (
                        <Badge tone={deadline.tone === 'neutral' ? 'warning' : deadline.tone}>
                          {deadline.text}
                        </Badge>
                      ) : (
                        <Badge tone="success">Handled</Badge>
                      )}
                      {conversation.assignedTo ? (
                        <Badge tone="info">
                          {conversation.assignedTo.name ?? conversation.assignedTo.email}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-8 max-w-prose text-xs text-ink-muted">
        Facebook and Instagram let a brand answer a private message only for a while after the
        person last wrote, and never write first. Conversations are kept while the account stays
        connected, and for no more than twelve months.
      </p>
    </main>
  );
}
