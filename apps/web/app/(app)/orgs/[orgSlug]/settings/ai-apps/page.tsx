import type { Metadata } from 'next';
import { Card, CardBody, CardHeader, CardTitle, Empty, PageHeader } from '@orbit/ui';
import { requirePageContext } from '@/server/page-context';
import { agentEnabledFor } from '@/features/agent/availability';
import { listGrants, mcpResource } from '@/features/agent/oauth';
import { GrantList } from '@/features/agent/ui/grant-list';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Connected AI apps' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
}

/**
 * Connect Claude, ChatGPT or another MCP client to Social Square, and see and
 * revoke what is connected (D-109 §6).
 */
export default async function AiAppsPage({ params }: PageProps) {
  const { orgSlug } = await params;
  const { ctx, organization } = await requirePageContext(orgSlug);
  const enabled = agentEnabledFor(organization);
  const grants = enabled ? await listGrants(ctx) : [];

  return (
    <main id="main" className="px-4 py-10 sm:px-6">
      <PageHeader
        eyebrow={organization.name}
        title="Connected AI apps"
        description="AI apps you connect act as you: they can only do what your role allows, within the permissions you gave them, and nothing outward happens until you confirm it."
      />
      <div className="mt-6 max-w-3xl space-y-6">
        {!enabled ? (
          <Empty
            title="AI agents are not enabled for this organization"
            description="Ask Social Square to turn them on."
          />
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Connect an AI app</CardTitle>
              </CardHeader>
              <CardBody className="space-y-2 text-sm text-ink-secondary">
                <p>
                  In Claude, ChatGPT or any app that supports MCP connectors, add a custom connector
                  with this URL, then sign in with your Social Square account and choose this
                  organization:
                </p>
                <code className="block break-all rounded bg-surface-sunken px-3 py-2 font-mono text-xs text-ink">
                  {mcpResource()}
                </code>
              </CardBody>
            </Card>
            {grants.length === 0 ? (
              <Empty title="No AI apps connected" description="Apps you connect appear here." />
            ) : (
              <GrantList
                orgSlug={organization.slug}
                grants={grants.map((g) => ({
                  id: g.id,
                  clientName: g.client.name,
                  scopes: g.scopes,
                  createdAt: g.createdAt.toISOString(),
                  lastUsedAt: g.lastUsedAt?.toISOString() ?? null,
                  person: g.user.name ?? g.user.email,
                }))}
              />
            )}
          </>
        )}
      </div>
    </main>
  );
}
