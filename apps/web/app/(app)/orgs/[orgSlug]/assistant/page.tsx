import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Empty, PageHeader, PermissionDenied } from '@orbit/ui';
import { pageCanSomewhere, requirePageContext } from '@/server/page-context';
import { listAssistants } from '@/features/assistant/service';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'AI Assistant' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
}

const MODE: Record<
  'OFF' | 'SUGGEST' | 'AUTO',
  { label: string; tone: 'neutral' | 'info' | 'success' }
> = {
  OFF: { label: 'Off', tone: 'neutral' },
  SUGGEST: { label: 'Suggests replies', tone: 'info' },
  AUTO: { label: 'Answers on its own', tone: 'success' },
};

/**
 * The AI Assistant, as a feature of its own (**D-108**).
 *
 * One place to see, for every brand the person may configure, whether the
 * assistant is on, what it knows and what it has done — and a way into each
 * brand's settings. It used to live only inside a brand's page, which made a
 * product-wide capability look like a per-client detail.
 */
export default async function AssistantOverviewPage({ params }: PageProps) {
  const { orgSlug } = await params;
  const { ctx, organization } = await requirePageContext(orgSlug);

  if (!pageCanSomewhere(ctx, 'ai_assistant:manage')) {
    return (
      <main id="main" className="px-4 py-10 sm:px-6">
        <PermissionDenied action="manage the AI assistant" />
      </main>
    );
  }

  const { brands, freeTier, disclosure } = await listAssistants(ctx);
  const on = brands.filter((brand) => brand.mode !== 'OFF').length;
  const waiting = brands.reduce((sum, brand) => sum + brand.waitingForPerson, 0);

  return (
    <main id="main" className="px-4 py-10 sm:px-6">
      <PageHeader
        eyebrow={organization.name}
        title="AI Assistant"
        description="Answers customers’ private messages on Facebook and Instagram from the documents each brand gives it, and hands everything else to the team."
      />

      <div className="mt-6 grid max-w-4xl gap-3 sm:grid-cols-3">
        <Stat label="Brands with the assistant on" value={`${on} / ${brands.length}`} />
        <Stat
          label="Waiting for a person"
          value={String(waiting)}
          tone={waiting > 0 ? 'warn' : 'plain'}
        />
        <Stat
          label="Replied on its own (30 days)"
          value={String(brands.reduce((sum, brand) => sum + brand.last30Days.replied, 0))}
        />
      </div>

      <div className="mt-4 max-w-4xl space-y-2 text-sm text-ink-secondary">
        <p>
          Every message it sends on its own ends with{' '}
          <span className="font-medium text-ink">“— {disclosure}”</span>. Refunds, complaints,
          orders, legal and safety matters, personal details and anything the documents do not cover
          always go to the team.
        </p>
        {freeTier ? (
          <p
            role="note"
            className="rounded-md border border-line bg-warning-soft px-3 py-2 text-ink"
          >
            <strong className="font-semibold">Free Gemini tier.</strong> Google may use what is sent
            to improve its products. Upgrade before using the assistant with clients’ customers in
            earnest.
          </p>
        ) : null}
      </div>

      <section aria-label="Brands" className="mt-8 max-w-4xl">
        {brands.length === 0 ? (
          <Empty
            title="No brands yet"
            description="Add a client and a brand first, then give the assistant something to answer from."
          />
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {brands.map((brand) => {
              const mode = MODE[brand.mode];
              const href = `/orgs/${orgSlug}/assistant/${brand.id}`;
              return (
                <li key={brand.id}>
                  <Link
                    href={href}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-ink">{brand.name}</span>
                        <Badge tone={mode.tone}>{mode.label}</Badge>
                        {brand.waitingForPerson > 0 ? (
                          <Badge tone="warning">
                            {brand.waitingForPerson} waiting for a person
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-xs text-ink-muted">
                        {brand.workspaceName} ·{' '}
                        {brand.knowledgeEntries === 0
                          ? 'No documents yet'
                          : `${brand.knowledgeEntries} document${brand.knowledgeEntries === 1 ? '' : 's'}`}{' '}
                        ·{' '}
                        {brand.messagingPlatforms.length === 0
                          ? 'No Facebook or Instagram connected'
                          : brand.messagingPlatforms
                              .map(
                                (platform) => platform.charAt(0) + platform.slice(1).toLowerCase(),
                              )
                              .join(' & ')}
                      </p>
                    </div>
                    <dl className="flex gap-4 text-right text-xs text-ink-muted">
                      <div>
                        <dt>Drafts</dt>
                        <dd className="text-sm font-semibold tabular-nums text-ink">
                          {brand.last30Days.suggested}
                        </dd>
                      </div>
                      <div>
                        <dt>Replied</dt>
                        <dd className="text-sm font-semibold tabular-nums text-ink">
                          {brand.last30Days.replied}
                        </dd>
                      </div>
                      <div>
                        <dt>Handed over</dt>
                        <dd className="text-sm font-semibold tabular-nums text-ink">
                          {brand.last30Days.escalated}
                        </dd>
                      </div>
                    </dl>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-2 text-xs text-ink-muted">Counts cover the last 30 days.</p>
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  tone = 'plain',
}: {
  label: string;
  value: string;
  tone?: 'plain' | 'warn';
}) {
  return (
    <div
      className={
        tone === 'warn'
          ? 'rounded-md border border-line bg-warning-soft px-3 py-2'
          : 'rounded-md border border-line bg-surface px-3 py-2'
      }
    >
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-ink">{value}</p>
    </div>
  );
}
