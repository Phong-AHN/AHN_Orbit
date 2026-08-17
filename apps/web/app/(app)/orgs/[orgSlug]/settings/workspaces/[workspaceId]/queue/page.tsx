import type { Metadata } from 'next';
import Link from 'next/link';
import { Breadcrumbs, PageHeader, PermissionDenied } from '@orbit/ui';
import { pageCan, requirePageContext } from '@/server/page-context';
import { getWorkspace } from '@/features/tenancy/service';
import { listAccounts } from '@/features/social/service';
import { listQueueSlots } from '@/features/scheduling/queue-slots';
import { QueueSlots } from '@/features/scheduling/ui/queue-slots';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Posting times' };

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceId: string }>;
}

/**
 * When a client normally posts (SRS §7).
 *
 * These slots are what "add to queue" resolves against — the scheduler has
 * honoured them since T1.12, and until now there was no way to create one
 * outside a seed script.
 *
 * Guarded by `post:read` to see and `post:schedule` to change: a slot is a
 * standing scheduling decision, so whoever may schedule a post may decide when
 * this client normally posts.
 */
export default async function QueueSlotsPage({ params }: PageProps) {
  const { orgSlug, workspaceId } = await params;
  const { ctx, organization } = await requirePageContext(orgSlug);

  if (!pageCan(ctx, 'post:read', { workspaceId })) {
    return (
      <main id="main" className="mx-auto max-w-3xl px-6 py-10">
        <PermissionDenied action="see this client's posting times" />
      </main>
    );
  }

  // Scoped, so a workspace from another tenant is simply not found.
  const workspace = await getWorkspace(ctx, workspaceId);

  const [slots, accounts] = await Promise.all([
    listQueueSlots(ctx, workspaceId),
    listAccounts(ctx, { workspaceId }),
  ]);

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-10">
      <Breadcrumbs
        className="mb-3"
        items={[
          { label: 'Clients', href: `/orgs/${orgSlug}/settings/workspaces` },
          { label: workspace.name },
          { label: 'Posting times' },
        ]}
      />

      <PageHeader
        eyebrow={organization.name}
        title="Posting times"
        description={`When ${workspace.name} normally posts. Times are in ${workspace.timezone.replace(/_/g, ' ')}.`}
      />

      <div className="mt-6">
        <QueueSlots
          orgSlug={orgSlug}
          workspaceId={workspaceId}
          workspaceTimeZone={workspace.timezone}
          slots={slots.map((slot) => ({
            id: slot.id,
            dayOfWeek: slot.dayOfWeek,
            localTime: slot.localTime,
            timezone: slot.timezone,
            isActive: slot.isActive,
            socialAccount: slot.socialAccount,
          }))}
          accounts={accounts.map((account) => ({
            id: account.id,
            displayName: account.displayName,
            platform: account.platform,
          }))}
          canManage={pageCan(ctx, 'post:schedule', { workspaceId })}
        />
      </div>

      <p className="mt-6 text-sm text-ink-muted">
        <Link href={`/orgs/${orgSlug}/settings/workspaces`} className="hover:underline">
          Back to clients
        </Link>
      </p>
    </main>
  );
}
