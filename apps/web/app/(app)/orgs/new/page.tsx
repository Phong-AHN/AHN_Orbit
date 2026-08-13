import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE_NAME, requireSession, resolveUser } from '@orbit/auth';
import { PageHeader } from '@orbit/ui';
import { CreateOrganizationForm } from '@/features/tenancy/ui/create-organization-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Create an organization' };

/**
 * Sits beside `[orgSlug]` rather than inside it, because there is no
 * organization yet — and therefore no tenant context, no org shell and no
 * navigation. All it needs is a signed-in user; `POST /api/v1/orgs` makes the
 * creator the owner, so there is no permission to check here beyond that.
 */
export default async function NewOrganizationPage() {
  const cookieStore = await cookies();

  try {
    const identity = await requireSession(cookieStore.get(SESSION_COOKIE_NAME)?.value);
    await resolveUser(identity);
  } catch {
    redirect('/sign-in?next=/orgs/new');
  }

  return (
    <main id="main" className="mx-auto max-w-xl px-6 py-16">
      <PageHeader
        title="Create an organization"
        description="An organization is your agency. Client workspaces, brands and connected accounts all live inside it."
      />

      <CreateOrganizationForm />

      <p className="mt-6 text-sm text-ink-muted">
        <Link href="/orgs" className="hover:underline">
          Back to your organizations
        </Link>
      </p>
    </main>
  );
}
