import Link from 'next/link';
import { requirePlatformAdmin } from '@/server/admin-context';

/**
 * The platform admin shell (SRS §28).
 *
 * Visually distinct from the agency surface on purpose: someone who is in here
 * is operating the SaaS, not using it, and the two should never be confused at
 * a glance — especially by a support engineer with both open.
 *
 * The gate runs here *and* in every page. A layout must not frame a surface the
 * viewer cannot have, and a page must not rely on its layout having checked.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requirePlatformAdmin();

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line-strong bg-surface-sunken">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-6 py-3">
          <Link href="/admin" className="text-sm font-semibold text-ink hover:underline">
            AHN Orbit · operations
          </Link>

          <nav
            aria-label="Admin"
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          >
            <AdminLink href="/admin" label="Health" />
            <AdminLink href="/admin/jobs" label="Dead letters" />
            <AdminLink href="/admin/organizations" label="Organizations" />
            <AdminLink href="/admin/users" label="Users" />
            <AdminLink href="/admin/accounts" label="Connections" />
          </nav>

          <span className="truncate text-xs text-ink-muted">{admin.email}</span>
        </div>
      </header>

      {children}
    </div>
  );
}

function AdminLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="whitespace-nowrap rounded px-2.5 py-1.5 text-sm text-ink-secondary transition-colors hover:bg-surface hover:text-ink"
    >
      {label}
    </Link>
  );
}
