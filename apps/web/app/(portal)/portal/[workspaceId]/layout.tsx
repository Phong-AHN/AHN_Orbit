import { requirePortalContext } from '@/server/portal-context';
import { PORTAL_NAV, shellGroups } from '@/features/navigation/nav-items';
import { AppShell } from '@/features/navigation/ui/app-shell';
import { NotificationBell } from '@/features/notifications/ui/notification-bell';

/**
 * The portal shell (SRS §21, decision D-012).
 *
 * The same rail as the agency surface, and deliberately the emptiest version of
 * it. There is no organization switcher, no primary action, and no reference to
 * the agency's own structure — a client sees their brand's name and three
 * places to go. Every extra affordance here is a chance to expose something
 * that belongs to the people who built it.
 *
 * **It does now carry a bell**, which it previously did not, and that was the
 * right call until the client had anything to be told. They do now: their own
 * review gate opening. The feed behind it is audience-scoped server-side to the
 * one notification type written for a client, so adding the affordance did not
 * open the surface to agency-shaped content.
 *
 * Sharing the shell rather than keeping a hand-written header is what stops the
 * portal quietly falling behind on the things a navigation has to get right —
 * the active destination, the phone layout, keyboard dismissal. Those were
 * fixed once in the agency bar and never carried across.
 *
 * The context is resolved here as well as in each page: a layout must not render
 * a client's brand name for a workspace they cannot reach, and a page must not
 * depend on its layout having checked.
 */
export default async function PortalLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { workspace } = await requirePortalContext(workspaceId);

  const base = `/portal/${workspace.id}`;

  return (
    <AppShell
      tone="client"
      brand={{ label: workspace.name, href: base }}
      groups={shellGroups(base, PORTAL_NAV)}
      utilities={
        <NotificationBell
          endpoint={`/api/v1/portal/workspaces/${encodeURIComponent(workspace.id)}/notifications`}
          postHrefBase={`${base}/posts`}
        />
      }
    >
      {children}
    </AppShell>
  );
}
