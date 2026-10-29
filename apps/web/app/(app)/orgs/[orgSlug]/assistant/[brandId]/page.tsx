import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ForbiddenError, NotFoundError } from '@orbit/core';
import { PageHeader, PermissionDenied } from '@orbit/ui';
import { pageCan, requirePageContext } from '@/server/page-context';
import { getBrand } from '@/features/tenancy/service';
import { getAssistant, type AssistantOverview } from '@/features/assistant/service';
import { AssistantSettingsForm } from '@/features/assistant/ui/assistant-settings-form';
import { KnowledgeEditor } from '@/features/assistant/ui/knowledge-editor';
import { AssistantTester } from '@/features/assistant/ui/assistant-tester';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'AI assistant' };

interface PageProps {
  params: Promise<{ orgSlug: string; brandId: string }>;
}

/**
 * One brand's AI assistant (**D-108**): what it knows, when it may answer, and
 * a place to ask it something before a customer does. Reached from the AI
 * Assistant section, which lists every brand.
 */
export default async function BrandAssistantPage({ params }: PageProps) {
  const { orgSlug, brandId } = await params;
  const { ctx, organization } = await requirePageContext(orgSlug);

  // The brand's workspace, so a workspace-scoped grant (an Account Manager's)
  // is judged against it. Scoped: another tenant's brand is not found.
  let workspaceId: string;
  try {
    workspaceId = (await getBrand(ctx, brandId)).workspaceId;
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  if (!pageCan(ctx, 'ai_assistant:manage', { workspaceId, brandId })) {
    return (
      <main id="main" className="px-4 py-10 sm:px-6">
        <PermissionDenied action="manage this brand’s AI assistant" />
      </main>
    );
  }

  let overview: AssistantOverview;
  try {
    overview = await getAssistant(ctx, brandId);
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) notFound();
    throw error;
  }

  const { brand, settings, stats } = overview;

  return (
    <main id="main" className="px-4 py-10 sm:px-6">
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
        <Link
          href={`/orgs/${orgSlug}/assistant`}
          className="text-ink-secondary underline-offset-2 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          &larr; AI Assistant
        </Link>
      </nav>

      <PageHeader
        eyebrow={`${organization.name} · ${brand.workspace.name}`}
        title={brand.name}
        description={`The AI assistant answers ${brand.name}’s private messages from the documents you give it, and hands everything else to the team.`}
      />

      <dl className="mt-6 grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Drafts (30 days)', value: stats.suggested },
          { label: 'Replied alone', value: stats.replied },
          { label: 'Handed over', value: stats.escalated },
          {
            label: 'Rated right',
            value:
              stats.ratedGood + stats.ratedBad > 0
                ? `${stats.ratedGood} / ${stats.ratedGood + stats.ratedBad}`
                : '—',
          },
        ].map((item) => (
          <div key={item.label} className="rounded-md border border-line bg-surface px-3 py-2">
            <dt className="text-xs text-ink-muted">{item.label}</dt>
            <dd className="text-lg font-semibold tabular-nums text-ink">{item.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-6 grid max-w-3xl gap-6">
        <AssistantSettingsForm
          orgSlug={orgSlug}
          brandId={brandId}
          timezone={brand.workspace.timezone}
          settings={{
            mode: settings.mode,
            staffedHours: settings.staffedHours,
            graceMinutes: settings.graceMinutes,
            holdingMessage: settings.holdingMessage,
            maxRepliesPerConversation: settings.maxRepliesPerConversation,
            escalationTerms: settings.escalationTerms,
          }}
          auto={{ allowed: overview.auto.allowed, reasons: overview.auto.reasons }}
          freeTier={overview.freeTier}
          disclosure={overview.disclosure}
          defaultHoldingMessage={overview.defaultHoldingMessage}
        />

        <KnowledgeEditor
          orgSlug={orgSlug}
          brandId={brandId}
          usedChars={overview.knowledgeChars}
          maxChars={overview.maxKnowledgeChars}
          entries={overview.entries.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            title: entry.title,
            question: entry.question,
            content: entry.content,
            usableByAssistant: entry.usableByAssistant,
            updatedAt: entry.updatedAt.toISOString(),
          }))}
        />

        <AssistantTester orgSlug={orgSlug} brandId={brandId} />
      </div>
    </main>
  );
}
