import { requirePlatformAdmin } from '@/server/admin-context';
import { ADMIN_NAV, shellGroups } from '@/features/navigation/nav-items';
import { AppShell } from '@/features/navigation/ui/app-shell';

/**
 * The platform admin shell (SRS §28).
 *
 * The same rail as the other two surfaces, in the sunken, harder-edged tone the
 * old admin header already used — and for the reason it was chosen there.
 * Someone in here is operating the SaaS, not using it, and the two should never
 * be confused at a glance, especially by a support engineer with both open.
 *
 * The gate runs here *and* in every page. A layout must not frame a surface the
 * viewer cannot have, and a page must not rely on its layout having checked.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requirePlatformAdmin();

  return (
    <AppShell
      tone="ops"
      brand={{ label: 'AHN Orbit', href: '/admin', sublabel: 'Platform operations' }}
      groups={shellGroups('/admin', ADMIN_NAV)}
      utilities={<span className="truncate text-xs text-ink-muted">{admin.email}</span>}
    >
      {children}
    </AppShell>
  );
}
