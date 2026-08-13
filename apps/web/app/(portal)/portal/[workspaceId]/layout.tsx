import Link from 'next/link';
import { requirePortalContext } from '@/server/portal-context';

/**
 * The portal shell (SRS §21, decision D-012).
 *
 * Deliberately unlike the agency shell. There is no organization switcher, no
 * notification bell, no reference to the agency's own structure — a client sees
 * their brand's name and three places to go. Every extra affordance here is a
 * chance to expose something that belongs to the people who built it.
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

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-3xl items-center gap-4 px-6 py-3">
          <Link
            href={`/portal/${workspace.id}`}
            className="truncate text-sm font-semibold text-ink hover:underline"
          >
            {workspace.name}
          </Link>

          <nav aria-label="Main" className="flex flex-1 items-center gap-1">
            <PortalLink href={`/portal/${workspace.id}`} label="To review" />
            <PortalLink href={`/portal/${workspace.id}/upcoming`} label="Upcoming" />
            <PortalLink href={`/portal/${workspace.id}/published`} label="Published" />
          </nav>
        </div>
      </header>

      {children}
    </div>
  );
}

function PortalLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="whitespace-nowrap rounded px-2.5 py-1.5 text-sm text-ink-secondary transition-colors hover:bg-surface-sunken hover:text-ink"
    >
      {label}
    </Link>
  );
}
