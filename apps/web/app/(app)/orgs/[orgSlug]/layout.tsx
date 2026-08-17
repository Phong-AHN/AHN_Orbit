import Link from 'next/link';
import { buttonClassName } from '@orbit/ui';
import { pageCanSomewhere, requirePageContext } from '@/server/page-context';
import { NotificationBell } from '@/features/notifications/ui/notification-bell';
import { NAV_GROUPS, PRIMARY_ACTIONS } from '@/features/navigation/nav-items';
import { OrgNav } from '@/features/navigation/ui/org-nav';

/**
 * The organization shell.
 *
 * **Navigation is derived from the permission matrix**, not written per role: a
 * destination appears when this principal holds the permission that guards it,
 * so a Content Creator's product genuinely looks like a content creator's
 * product rather than an owner's with grey links. Hiding is not the security
 * control — the route and the API each check independently — it is what stops
 * the menu being full of things that would refuse you.
 *
 * The header also carries one **primary action**, chosen by the same means. An
 * Approver has nothing to create; their work arrives, so their button is the
 * review queue.
 *
 * `requirePageContext` runs here as well as in each page. That is intentional
 * rather than wasteful: a layout must not render for an organization the viewer
 * has no membership in, and a page must not depend on its layout having
 * checked. Both redirect identically.
 */
export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { ctx, organization } = await requirePageContext(orgSlug);

  const base = `/orgs/${orgSlug}`;

  const groups = NAV_GROUPS.map((group) => ({
    label: group.label,
    items: group.items
      .filter((item) => !item.permission || pageCanSomewhere(ctx, item.permission))
      .map((item) => ({
        label: item.label,
        href: `${base}${item.path}`,
        ...(item.exact ? { exact: true } : {}),
      })),
  })).filter((group) => group.items.length > 0);

  const primary = PRIMARY_ACTIONS.find((action) => pageCanSomewhere(ctx, action.permission));

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="relative border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-3">
          <Link
            href={`${base}/dashboard`}
            className="shrink-0 truncate rounded text-sm font-semibold text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {organization.name}
          </Link>

          <OrgNav groups={groups} />

          <div className="flex shrink-0 items-center gap-2">
            {primary ? (
              <Link
                href={`${base}${primary.path}`}
                className={buttonClassName({ size: 'sm', className: 'hidden sm:inline-flex' })}
              >
                {primary.label}
              </Link>
            ) : null}

            <NotificationBell orgSlug={orgSlug} />
          </div>
        </div>
      </header>

      {children}
    </div>
  );
}
