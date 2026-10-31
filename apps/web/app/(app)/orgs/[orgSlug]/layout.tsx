import { pageCanSomewhere, requirePageContext } from '@/server/page-context';
import { NotificationBell } from '@/features/notifications/ui/notification-bell';
import { NAV_GROUPS, PRIMARY_ACTIONS, shellGroups } from '@/features/navigation/nav-items';
import { AppShell } from '@/features/navigation/ui/app-shell';
import { unhandledCount } from '@/features/community/service';
import { messagingAvailable, waitingConversationCount } from '@/features/messaging/service';
import { ensureProvidersRegistered } from '@/server/providers';
import { copilotAvailability } from '@/features/copilot/service';
import { CopilotBubble } from '@/features/copilot/ui/copilot-bubble';
import { ProductTour } from '@/features/onboarding/ui/product-tour';

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
 * The rail also carries one **primary action**, chosen by the same means. An
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

  const groups = shellGroups(base, NAV_GROUPS, (permission) => pageCanSomewhere(ctx, permission), {
    '/community': await waitingInCommunity(ctx),
  });

  const primary = PRIMARY_ACTIONS.find((action) => pageCanSomewhere(ctx, action.permission));

  // The Copilot bubble, on every page, for whoever may use it (D-109). The
  // routes behind it check again; this only decides whether to offer it.
  const showCopilot =
    pageCanSomewhere(ctx, 'ai:generate') && copilotAvailability(organization).available;

  return (
    <AppShell
      tone="agency"
      brand={{ label: organization.name, href: `${base}/dashboard` }}
      groups={groups}
      {...(primary ? { action: { label: primary.label, href: `${base}${primary.path}` } } : {})}
      utilities={
        <>
          {/* The onboarding tour, and its "?" to take it again. */}
          <ProductTour orgSlug={orgSlug} />
          <span data-tour="notifications" className="inline-flex">
            <NotificationBell
              endpoint={`/api/v1/orgs/${encodeURIComponent(orgSlug)}/notifications`}
              postHrefBase={`${base}/posts`}
              conversationHrefBase={`${base}/community/messages`}
              accountHref={`${base}/settings/accounts`}
            />
          </span>
        </>
      }
    >
      {children}
      {showCopilot ? <CopilotBubble orgSlug={orgSlug} /> : null}
    </AppShell>
  );
}

/**
 * Comments and conversations waiting for somebody, for the count beside
 * Community. Two indexed counts per page load, each skipped for a person who
 * could not open what it counts — so the number never promises work the inbox
 * will not show them.
 */
async function waitingInCommunity(ctx: Parameters<typeof unhandledCount>[0]): Promise<number> {
  const comments = pageCanSomewhere(ctx, 'comment:read_public') ? await unhandledCount(ctx) : 0;

  ensureProvidersRegistered();
  const messages =
    messagingAvailable() && pageCanSomewhere(ctx, 'message:read')
      ? await waitingConversationCount(ctx)
      : 0;

  return comments + messages;
}
