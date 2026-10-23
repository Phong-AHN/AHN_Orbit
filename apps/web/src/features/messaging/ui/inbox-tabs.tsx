import Link from 'next/link';
import { cn } from '@orbit/ui';

/**
 * Comments and messages, as two tabs of one inbox (**D-107**).
 *
 * Shown only where messages exist — a deployment with messaging switched off,
 * or a person without `message:read`, sees the comment inbox exactly as before.
 */
export function InboxTabs({
  orgSlug,
  active,
  waitingMessages,
}: {
  orgSlug: string;
  active: 'comments' | 'messages';
  waitingMessages: number;
}) {
  const tabs = [
    { key: 'comments', label: 'Comments', href: `/orgs/${orgSlug}/community` },
    {
      key: 'messages',
      label: waitingMessages > 0 ? `Messages (${waitingMessages.toLocaleString()})` : 'Messages',
      href: `/orgs/${orgSlug}/community/messages`,
    },
  ] as const;

  return (
    <nav aria-label="Inbox" className="mt-6 flex gap-1 border-b border-line">
      {tabs.map((tab) => {
        const current = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={current ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              current
                ? 'border-accent font-semibold text-ink'
                : 'border-transparent text-ink-secondary hover:text-ink',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
