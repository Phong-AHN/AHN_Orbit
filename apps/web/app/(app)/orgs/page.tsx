import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  SESSION_COOKIE_NAME,
  listAccessibleOrganizations,
  requireSession,
  resolveUser,
} from '@orbit/auth';
import { Badge, Card, CardBody, Empty, PageHeader } from '@orbit/ui';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Your organizations' };

/**
 * The organization picker.
 *
 * Where `requirePageContext` sends anyone who asks for an organization they are
 * not a member of — which is the same place it sends someone asking for one
 * that does not exist, deliberately, so page navigation cannot be used to
 * enumerate tenants either.
 *
 * Also the landing surface after sign-in. A person with exactly one
 * organization is sent straight into it; the picker exists for the agency
 * founder who also does contract work for another.
 */
export default async function OrganizationsPage() {
  const cookieStore = await cookies();

  let userId: string;
  try {
    const identity = await requireSession(cookieStore.get(SESSION_COOKIE_NAME)?.value);
    userId = (await resolveUser(identity)).id;
  } catch {
    redirect('/sign-in?next=/orgs');
  }

  const organizations = await listAccessibleOrganizations(userId);

  if (organizations.length === 1) {
    redirect(`/orgs/${organizations[0]!.slug}/dashboard`);
  }

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-16">
      <PageHeader title="Your organizations" description="Choose which agency to work in." />

      {organizations.length === 0 ? (
        <Empty
          className="mt-8"
          title="You are not in an organization yet"
          description="Ask whoever runs your agency to invite you, or create one to get started."
        />
      ) : (
        <ul className="mt-8 space-y-2">
          {organizations.map((organization) => (
            <li key={organization.id}>
              <Card>
                <CardBody className="flex flex-wrap items-center justify-between gap-2">
                  <Link
                    href={`/orgs/${organization.slug}/dashboard`}
                    className="text-sm font-semibold text-ink hover:underline"
                  >
                    {organization.name}
                  </Link>
                  <Badge tone="neutral">{organization.role.toLowerCase().replace('_', ' ')}</Badge>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
