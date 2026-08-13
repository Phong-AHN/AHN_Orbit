import type { Metadata } from 'next';
import { Card, CardBody, Empty, PageHeader } from '@orbit/ui';
import { requirePlatformAdmin } from '@/server/admin-context';
import { listOrganizations } from '@/features/admin/service';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Organizations' };

/**
 * Tenants, as operational records (docs/RBAC.md §3 note 1).
 *
 * Name, plan, counts. There is no link into an organization from here, because
 * there is nowhere for it to lead: a platform admin has no membership and
 * therefore no tenant context, so the agency surface would refuse them anyway.
 */
export default async function AdminOrganizationsPage() {
  await requirePlatformAdmin();

  const organizations = await listOrganizations();

  return (
    <main id="main" className="mx-auto max-w-5xl px-6 py-10">
      <PageHeader title="Organizations" description="Who is on the platform, and how big." />

      {organizations.length === 0 ? (
        <Empty className="mt-8" title="No organizations yet" />
      ) : (
        <Card className="mt-8">
          <CardBody className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-muted">
                  <th scope="col" className="px-4 py-2 font-medium">
                    Organization
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Plan
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Members
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Clients
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Connections
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Posts
                  </th>
                </tr>
              </thead>
              <tbody>
                {organizations.map((organization) => (
                  <tr key={organization.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5">
                      <span className="font-medium text-ink">{organization.name}</span>
                      <span className="ml-2 font-mono text-xs text-ink-muted">
                        {organization.slug}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-ink-secondary">
                      {organization.subscription
                        ? `${organization.subscription.plan} · ${organization.subscription.status}`
                        : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-secondary">
                      {organization._count.memberships}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-secondary">
                      {organization._count.workspaces}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-secondary">
                      {organization._count.socialAccounts}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-secondary">
                      {organization._count.posts}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}
    </main>
  );
}
