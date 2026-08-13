import type { Metadata } from 'next';
import { Badge, Card, CardBody, Empty, PageHeader } from '@orbit/ui';
import { requirePlatformAdmin } from '@/server/admin-context';
import { listSocialAccountHealth } from '@/features/admin/service';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Connections' };

/**
 * Connection health across every tenant (docs/RBAC.md §3 note 2).
 *
 * **Status only.** No account names, no handles, no Page ids — which Pages a
 * client manages is their commercial information, not platform state. What this
 * answers is "is anything broken, and whose", so support can tell an agency to
 * look; the agency's own accounts page tells them which one (**D-044**).
 */
export default async function AdminAccountsPage() {
  await requirePlatformAdmin();

  const accounts = await listSocialAccountHealth();
  const broken = accounts.filter((account) => account.status === 'NEEDS_RECONNECT');

  return (
    <main id="main" className="mx-auto max-w-5xl px-6 py-10">
      <PageHeader
        title="Connections"
        description="Platform-wide connection status. Names and Page ids stay with the agency."
      />

      {broken.length > 0 ? (
        <p className="mt-4 text-sm font-medium text-danger">
          {broken.length} connection{broken.length === 1 ? '' : 's'} need
          {broken.length === 1 ? 's' : ''} reconnecting.
        </p>
      ) : null}

      {accounts.length === 0 ? (
        <Empty className="mt-8" title="No connections yet" />
      ) : (
        <Card className="mt-6">
          <CardBody className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-muted">
                  <th scope="col" className="px-4 py-2 font-medium">
                    Organization
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Platform
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Last checked
                  </th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5 font-medium text-ink">
                      {account.organization.name}
                    </td>
                    <td className="px-4 py-2.5 text-ink-secondary">{account.platform}</td>
                    <td className="px-4 py-2.5">
                      <Badge tone={account.status === 'ACTIVE' ? 'success' : 'danger'}>
                        {account.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-ink-muted">
                      {account.healthCheckedAt
                        ? account.healthCheckedAt.toISOString().slice(0, 16)
                        : 'never'}
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
