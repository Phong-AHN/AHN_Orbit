import type { Metadata } from 'next';
import Link from 'next/link';
import { Empty, PageHeader } from '@orbit/ui';
import { requirePageContext } from '@/server/page-context';
import { listMyActions } from '@/features/agent/actions';
import { agentEnabledFor } from '@/features/agent/availability';
import { ActionList, type ActionRow } from '@/features/agent/ui/action-list';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'AI agent actions' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Where a person confirms what an AI agent prepared for them (D-109 §5). */
export default async function AgentActionsPage({ params, searchParams }: PageProps) {
  const { orgSlug } = await params;
  const { ctx, organization } = await requirePageContext(orgSlug);
  const query = await searchParams;
  const highlight = typeof query.action === 'string' ? query.action : null;

  const enabled = agentEnabledFor(organization);
  const actions = enabled ? await listMyActions(ctx) : [];

  return (
    <main id="main" className="px-4 py-10 sm:px-6">
      <PageHeader
        eyebrow={organization.name}
        title="AI agent actions"
        description="Publishing, scheduling, sending to a client and replying to customers wait here until you confirm them. Read each one: it is exactly what will happen."
      />
      <div className="mt-6 max-w-3xl">
        {!enabled ? (
          <Empty
            title="AI agents are not enabled for this organization"
            description="Ask Social Square to turn them on."
          />
        ) : actions.length === 0 ? (
          <Empty
            title="Nothing waiting"
            description="When an AI agent prepares something that needs your confirmation, it appears here."
          />
        ) : (
          <ActionList
            orgSlug={organization.slug}
            highlight={highlight}
            actions={actions.map((a): ActionRow => ({
              id: a.id,
              channel: a.channel,
              tool: a.tool,
              summary: a.summary,
              status: a.status,
              expiresAt: a.expiresAt.toISOString(),
              error: a.error,
              createdAt: a.createdAt.toISOString(),
            }))}
          />
        )}
        <p className="mt-6 text-sm text-ink-secondary">
          Manage which AI apps can act for you in{' '}
          <Link
            className="text-accent underline"
            href={`/orgs/${organization.slug}/settings/ai-apps`}
          >
            Connected AI apps
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
