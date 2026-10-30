import type { Metadata } from 'next';
import Link from 'next/link';
import { Empty, PageHeader } from '@orbit/ui';
import { requirePageContext } from '@/server/page-context';
import { copilotAvailability, getThread, listThreads } from '@/features/copilot/service';
import { CopilotChat } from '@/features/copilot/ui/copilot-chat';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Copilot' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The in-app Copilot (D-109 phase 5): Social Square, by chat. */
export default async function CopilotPage({ params, searchParams }: PageProps) {
  const { orgSlug } = await params;
  const { ctx, organization } = await requirePageContext(orgSlug);
  const query = await searchParams;
  const requested =
    typeof query.thread === 'string' && UUID.test(query.thread) ? query.thread : null;

  const availability = copilotAvailability(organization);
  if (!availability.available) {
    return (
      <main id="main" className="px-4 py-10 sm:px-6">
        <PageHeader eyebrow={organization.name} title="Copilot" />
        <div className="mt-6 max-w-2xl">
          <Empty
            title={
              availability.reason === 'NOT_ENABLED'
                ? 'AI agents are not enabled for this organization'
                : 'The Copilot is not available yet'
            }
            description={
              availability.reason === 'NOT_ENABLED'
                ? 'Ask Social Square to turn them on.'
                : 'It needs a paid AI plan, so your clients’ data is never used to train a model. Meanwhile you can connect Claude or ChatGPT in Connected AI apps.'
            }
          />
        </div>
      </main>
    );
  }

  const threads = await listThreads(ctx);
  const thread = requested ? await getThread(ctx, requested).catch(() => null) : null;

  return (
    <main id="main" className="px-4 py-10 sm:px-6">
      <PageHeader
        eyebrow={organization.name}
        title="Copilot"
        description="Plan, write, schedule and reply by chatting. It can only do what your role allows, and anything that goes out waits for your confirmation."
      />
      <div className="mt-6 grid max-w-6xl gap-6 lg:grid-cols-[14rem_1fr]">
        <nav aria-label="Conversations" className="space-y-1 text-sm">
          <Link
            href={`/orgs/${organization.slug}/copilot`}
            className="block rounded-md border border-line px-3 py-2 font-medium text-ink"
          >
            New conversation
          </Link>
          {threads.map((t) => (
            <Link
              key={t.id}
              href={`/orgs/${organization.slug}/copilot?thread=${t.id}`}
              aria-current={t.id === thread?.id ? 'page' : undefined}
              className={`block truncate rounded-md px-3 py-2 ${
                t.id === thread?.id ? 'bg-surface-sunken text-ink' : 'text-ink-secondary'
              }`}
            >
              {t.title}
            </Link>
          ))}
        </nav>
        <CopilotChat
          key={thread?.id ?? 'new'}
          orgSlug={organization.slug}
          threadId={thread?.id ?? null}
          initialMessages={thread?.messages ?? []}
        />
      </div>
    </main>
  );
}
