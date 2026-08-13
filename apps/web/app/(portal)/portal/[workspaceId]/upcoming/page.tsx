import type { Metadata } from 'next';
import Link from 'next/link';
import { clock } from '@orbit/core';
import { Badge, Card, CardBody, Empty, PageHeader } from '@orbit/ui';
import { requirePortalContext } from '@/server/portal-context';
import { listPortalCalendar } from '@/features/portal/service';
import { clientStatusLabel, clientStatusTone } from '@/features/portal/ui/status';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Upcoming' };

interface PageProps {
  params: Promise<{ workspaceId: string }>;
}

/** The next 30 days. A list rather than a grid — most clients have a handful a week. */
export default async function PortalUpcomingPage({ params }: PageProps) {
  const { workspaceId } = await params;
  const { ctx, workspace } = await requirePortalContext(workspaceId);

  const from = clock.now();
  const to = new Date(from.getTime() + 30 * 86_400_000);

  const posts = await listPortalCalendar(ctx, workspaceId, { from, to });

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-10">
      <PageHeader
        eyebrow={workspace.name}
        title="Upcoming"
        description="What is planned over the next month."
      />

      {posts.length === 0 ? (
        <Empty
          className="mt-8"
          title="Nothing scheduled yet"
          description="Approved content appears here once it has a date."
        />
      ) : (
        <ul className="mt-8 space-y-2.5">
          {posts.map((post) => (
            <li key={post.id}>
              <Card>
                <CardBody>
                  <Link
                    href={`/portal/${workspaceId}/posts/${post.id}`}
                    className="block focus:outline-none"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
                        {post.title ?? post.body.trim().slice(0, 60)}
                      </span>
                      <Badge tone={clientStatusTone(post.status)}>
                        {clientStatusLabel(post.status)}
                      </Badge>
                    </div>

                    {post.scheduledFor ? (
                      <p className="mt-1 text-xs text-ink-muted">
                        {new Intl.DateTimeFormat('en-GB', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                          timeZone: post.timezone ?? workspace.timezone,
                        }).format(post.scheduledFor)}
                      </p>
                    ) : null}
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
