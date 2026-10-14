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
import { homeForUser } from '@/server/home';
import { Badge, Card, CardBody, Empty, PageHeader, buttonClassName } from '@orbit/ui';

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
 * **No longer the landing surface after sign-in** — `/continue` is, because
 * deciding which of the three surfaces is yours needs more than a list of
 * organizations. This page still has to handle arriving here, though: it is
 * where `requirePageContext` sends anyone asking for an organization that is
 * not theirs, and a client can reach it that way.
 *
 * A `CLIENT` membership is not a reason to show this page. A client belongs in
 * the portal, and forwarding one into `/orgs/{slug}/dashboard` — which is what
 * the single-organization shortcut below used to do to them — put them in the
 * agency app, whose API refuses them on every call.
 */
export default async function OrganizationsPage() {
  const cookieStore = await cookies();

  let user: Awaited<ReturnType<typeof resolveUser>>;
  try {
    const identity = await requireSession(cookieStore.get(SESSION_COOKIE_NAME)?.value);
    user = await resolveUser(identity);
  } catch {
    redirect('/sign-in?next=/orgs');
  }

  // Staff memberships only. A client reaching this page is somebody who was
  // sent here by a failed organization lookup, and listing the organizations
  // they are a *client* of would both be the wrong product and name the agency
  // they work with back at them.
  const organizations = (await listAccessibleOrganizations(user.id)).filter(
    (organization) => organization.role !== 'CLIENT',
  );

  if (organizations.length === 0) {
    // Nothing for them here, but that does not mean nothing anywhere: a client,
    // or a platform admin, has a home that is not this one.
    const home = await homeForUser(user);
    if (home.surface !== 'agency') redirect(home.path ?? '/continue');
  }

  if (organizations.length === 1) {
    redirect(`/orgs/${organizations[0]!.slug}/dashboard`);
  }

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-16">
      <PageHeader
        title="Your organizations"
        description="Choose which agency to work in."
        actions={
          <Link href="/orgs/new" className={buttonClassName({ variant: 'secondary', size: 'sm' })}>
            New organization
          </Link>
        }
      />

      {organizations.length === 0 ? (
        <Empty
          className="mt-8"
          title="You are not in an organization yet"
          description="Ask whoever runs your agency to invite you, or create one to get started."
          action={
            <Link href="/orgs/new" className={buttonClassName()}>
              Create an organization
            </Link>
          }
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
