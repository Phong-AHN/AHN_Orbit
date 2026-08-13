import type { Metadata } from 'next';
import { Badge, Card, CardBody, Empty, PageHeader } from '@orbit/ui';
import { requirePlatformAdmin } from '@/server/admin-context';
import { listUsers } from '@/features/admin/service';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Users' };

/**
 * People, for support lookups (docs/RBAC.md §4.1).
 *
 * Who someone is and where they belong. Nothing about what they have written.
 */
export default async function AdminUsersPage() {
  await requirePlatformAdmin();

  const users = await listUsers();

  return (
    <main id="main" className="mx-auto max-w-5xl px-6 py-10">
      <PageHeader title="Users" description="Accounts on the platform." />

      {users.length === 0 ? (
        <Empty className="mt-8" title="No users yet" />
      ) : (
        <ul className="mt-8 space-y-2">
          {users.map((user) => (
            <li key={user.id}>
              <Card>
                <CardBody>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{user.name ?? user.email}</span>
                    {user.name ? (
                      <span className="text-xs text-ink-muted">{user.email}</span>
                    ) : null}
                    {user.isPlatformAdmin ? <Badge tone="warning">Platform admin</Badge> : null}
                  </div>

                  {user.organizationMemberships.length > 0 ? (
                    <p className="mt-1 text-xs text-ink-muted">
                      {user.organizationMemberships
                        .map((m) => `${m.organization.name} (${m.role.toLowerCase()})`)
                        .join(' · ')}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-ink-muted">No organization memberships</p>
                  )}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
