import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, CardBody, Empty, PageHeader } from '@orbit/ui';
import { requirePortalContext } from '@/server/portal-context';
import { listPortalApprovals } from '@/features/portal/service';
import { clientStatusLabel, clientStatusTone } from '@/features/portal/ui/status';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'To review' };

interface PageProps {
  params: Promise<{ workspaceId: string }>;
}

/**
 * What is waiting on the client.
 *
 * The portal opens on the one thing the client is here to do. An empty state is
 * a good outcome, not a gap — "nothing to review" is exactly what a client with
 * a well-run agency should usually see.
 */
export default async function PortalReviewPage({ params }: PageProps) {
  const { workspaceId } = await params;
  const { ctx, workspace } = await requirePortalContext(workspaceId);

  const approvals = await listPortalApprovals(ctx, workspaceId);

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-10">
      <PageHeader
        eyebrow={workspace.name}
        title="To review"
        description="Content waiting for your approval."
      />

      {approvals.length === 0 ? (
        <Empty
          className="mt-8"
          title="Nothing to review"
          description="When your agency sends something across, it will appear here."
        />
      ) : (
        <ul className="mt-8 space-y-2.5">
          {approvals.map((approval) => (
            <li key={approval.id}>
              <Card className="border-warning/40">
                <CardBody>
                  <Link
                    href={`/portal/${workspaceId}/posts/${approval.post.id}`}
                    className="block focus:outline-none"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
                        {approval.post.title ?? preview(approval.post.body)}
                      </span>
                      <Badge tone={clientStatusTone(approval.post.status)}>
                        {clientStatusLabel(approval.post.status)}
                      </Badge>
                    </div>

                    <p className="mt-1 text-sm text-ink-muted">{preview(approval.post.body)}</p>

                    <p className="mt-1.5 text-xs font-medium text-warning">
                      Open to approve or ask for changes
                    </p>
                  </Link>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function preview(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed || 'Untitled';
}
