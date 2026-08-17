import type { Metadata } from 'next';
import { Empty, PageHeader, PermissionDenied } from '@orbit/ui';
import { pageCan, requirePageContext } from '@/server/page-context';
import { listActivity } from '@/features/activity/service';
import { ActivityFeed } from '@/features/activity/ui/activity-feed';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Activity' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ workspaceId?: string; resourceId?: string }>;
}

/**
 * The activity feed (SRS §41).
 *
 * Answers the question an agency gets in writing from its client: who changed
 * this, and when. The rows have existed since T0.6; this is the first surface
 * that reads them.
 */
export default async function ActivityPage({ params, searchParams }: PageProps) {
  const { orgSlug } = await params;
  const { workspaceId, resourceId } = await searchParams;
  const { ctx, organization } = await requirePageContext(orgSlug);

  if (!pageCan(ctx, 'audit:read', workspaceId ? { workspaceId } : {})) {
    return (
      <main id="main" className="mx-auto max-w-4xl px-6 py-10">
        <PermissionDenied action="see the activity log" />
      </main>
    );
  }

  const { entries, nextCursor } = await listActivity(ctx, {
    ...(workspaceId ? { workspaceId } : {}),
    ...(resourceId ? { resourceId } : {}),
  });

  return (
    <main id="main" className="mx-auto max-w-4xl px-6 py-10">
      <PageHeader
        eyebrow={organization.name}
        title="Activity"
        description="Every change, in order, with who made it. Append-only — nothing here can be edited."
      />

      {entries.length === 0 ? (
        <Empty
          title="Nothing recorded yet"
          description="Actions across your organization will appear here as they happen."
        />
      ) : (
        <ActivityFeed
          orgSlug={orgSlug}
          initial={entries.map(serialize)}
          initialCursor={nextCursor}
          {...(resourceId ? { resourceId } : {})}
          {...(workspaceId ? { workspaceId } : {})}
        />
      )}
    </main>
  );
}

type Entry = Awaited<ReturnType<typeof listActivity>>['entries'][number];

function serialize(entry: Entry) {
  return { ...entry, createdAt: entry.createdAt.toISOString() };
}
