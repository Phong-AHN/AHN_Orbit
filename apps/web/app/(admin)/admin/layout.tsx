import { logger } from '@orbit/observability';
import { requirePlatformAdmin } from '@/server/admin-context';
import { ADMIN_NAV, shellGroups } from '@/features/navigation/nav-items';
import { AppShell } from '@/features/navigation/ui/app-shell';
import { countPendingPlanRequests } from '@/features/admin/plans';

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
  // Requests waiting for an answer (D-116). A count that fails (the table not
  // migrated yet, say) is logged and shown as nothing, rather than taking every
  // admin page down with it.
  const pendingPlans = await countPendingPlanRequests().catch((error: unknown) => {
    logger.warn('could not count pending plan requests', { error });
    return 0;
  });

  return (
    <AppShell
      tone="ops"
      brand={{ label: 'Social Square', href: '/admin', sublabel: 'Platform operations' }}
      groups={shellGroups('/admin', ADMIN_NAV, undefined, { '/plans': pendingPlans })}
      account={{ name: admin.name, email: admin.email }}
    >
      {children}
    </AppShell>
  );
}
