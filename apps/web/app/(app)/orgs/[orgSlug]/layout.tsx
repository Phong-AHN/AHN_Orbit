import Link from 'next/link';
import { requirePageContext } from '@/server/page-context';
import { NotificationBell } from '@/features/notifications/ui/notification-bell';

/**
 * The organization shell (T1.15).
 *
 * Added here because the notification bell has to live somewhere every page
 * shows, and until now each page rendered its own `<main>` with nothing around
 * it. Deliberately thin: a bar with the organization, the handful of
 * destinations that exist, and the bell. It is not an attempt at the full
 * navigation — that belongs with the dashboard (T1.17), which will know what
 * the primary surfaces actually are.
 *
 * `requirePageContext` runs here as well as in each page. That is intentional
 * rather than wasteful: a layout must not render a bell for an organization the
 * viewer has no membership in, and a page must not depend on its layout having
 * checked. Both redirect identically, so the outcome is the same either way.
 */
export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { organization } = await requirePageContext(orgSlug);

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-6 py-3">
          <Link
            href={`/orgs/${orgSlug}/dashboard`}
            className="truncate text-sm font-semibold text-ink hover:underline"
          >
            {organization.name}
          </Link>

          <nav aria-label="Main" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            <NavLink href={`/orgs/${orgSlug}/dashboard`} label="Today" />
            <NavLink href={`/orgs/${orgSlug}/posts`} label="Posts" />
            <NavLink href={`/orgs/${orgSlug}/calendar`} label="Calendar" />
            <NavLink href={`/orgs/${orgSlug}/approvals`} label="Approvals" />
            <NavLink href={`/orgs/${orgSlug}/publishing`} label="Publishing" />
            <NavLink href={`/orgs/${orgSlug}/settings/accounts`} label="Accounts" />
          </nav>

          <NotificationBell orgSlug={orgSlug} />
        </div>
      </header>

      {children}
    </div>
  );
}

function NavLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="whitespace-nowrap rounded px-2.5 py-1.5 text-sm text-ink-secondary transition-colors hover:bg-surface-sunken hover:text-ink"
    >
      {label}
    </Link>
  );
}
