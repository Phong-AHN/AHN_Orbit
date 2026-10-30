import type { Metadata } from 'next';
import Link from 'next/link';
import { Empty, PageHeader } from '@orbit/ui';
import { requirePageContext } from '@/server/page-context';
import { copilotOnFreeTier } from '@/server/ai-provider';
import { copilotAvailability, getThread, listThreads } from '@/features/copilot/service';
import { CopilotChat } from '@/features/copilot/ui/copilot-chat';
import { ASSISTANT_NAME } from '@/features/copilot/name';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: ASSISTANT_NAME };

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
        <PageHeader eyebrow={organization.name} title={ASSISTANT_NAME} />
        <div className="mt-6 max-w-2xl">
          <Empty
            title={
              availability.reason === 'NOT_ENABLED'
                ? 'AI agents are not enabled for this organization'
                : `${ASSISTANT_NAME} is not available yet`
            }
            description={
              availability.reason === 'NOT_ENABLED'
                ? 'Ask Social Square to turn them on.'
                : 'No AI model is configured. Meanwhile you can connect Claude or ChatGPT in Connected AI apps.'
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
        title={ASSISTANT_NAME}
        description="Plan, write, schedule and reply by chatting. It can only do what your role allows, and anything that goes out waits for your confirmation."
      />
      {copilotOnFreeTier() ? (
        <p
          role="note"
          className="mt-4 max-w-6xl rounded-md border border-line bg-warning-soft px-4 py-3 text-sm text-ink"
        >
          Test mode: {ASSISTANT_NAME} runs on Gemini’s free tier, where Google may use what is sent
          to improve its products. Use test data only — not real clients’ content.
        </p>
      ) : null}
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
