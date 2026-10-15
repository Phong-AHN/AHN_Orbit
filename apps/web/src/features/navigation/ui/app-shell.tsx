'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { buttonClassName, cn } from '@orbit/ui';
import { bestMatch } from '../active-path';

/**
 * The application shell: a left sidebar, a slim utility bar, and the page.
 *
 * Used by all three surfaces — agency, client portal and platform operations —
 * so that "where am I" and "what else is there" are answered the same way
 * everywhere, while each surface still looks like itself.
 *
 * ## Why a sidebar rather than the top bar it replaces
 *
 * The old agency navigation was a single scrolling row of up to eleven links.
 * It worked, and it cost two things a rail gets back:
 *
 * - **The groups became visible.** `NAV_GROUPS` has always been structured —
 *   Work, Clients, Insight, Settings — and a horizontal bar had no room for
 *   headings, so the structure existed in the code and nowhere on screen. It
 *   only showed on phones, which is exactly backwards: the big screen is where
 *   there is room for it.
 * - **Adding a destination stopped being a layout problem.** A twelfth link in
 *   a row competes for horizontal space with the organization name and the
 *   primary action. A rail just gets longer.
 *
 * ## The surfaces stay distinguishable
 *
 * `tone` is not decoration. Somebody operating the SaaS and somebody using it
 * should never be confused about which one they are doing — particularly a
 * support engineer with both open — so operations gets the sunken, harder-edged
 * treatment the old admin header already used, and the client portal stays the
 * plainest of the three.
 *
 * ## The page fills the column; it does not centre inside it
 *
 * A page under this shell carries a gutter and **no maximum width**. The caps
 * it used to carry were all chosen against the old full-width top bar — a page
 * at 896px looked centred under a 1152px header — and once the 15rem rail
 * arrived they were being centred in what was left instead, which put ~390px
 * of dead space on each side of a list on a 1920px screen.
 *
 * What stops that becoming unreadable prose is `max-w-measure` on the
 * paragraph rather than a cap on the page: `PageHeader` and `MessageState`
 * already carry it, so running text keeps its measure while tables, grids and
 * calendars get the whole column.
 *
 * ## Navigation is still not a security control
 *
 * The server hands this component an already-filtered list; the permission
 * matrix lives there. Hiding a destination is what stops a menu being full of
 * things that would refuse you — the route and the API each check again,
 * independently.
 */

export type SurfaceTone = 'agency' | 'client' | 'ops';

export interface ShellNavItem {
  label: string;
  href: string;
  /** Match the href exactly rather than as a prefix. */
  exact?: boolean | undefined;
}

export interface ShellNavGroup {
  /** Shown as a heading in the rail. Empty hides the heading. */
  label: string;
  items: ShellNavItem[];
}

export interface AppShellProps {
  /** The masthead. `label` is the tenant's own name wherever there is one. */
  brand: { label: string; href: string; sublabel?: string | undefined };
  groups: ShellNavGroup[];
  /** The one thing this role most likely came to do. */
  action?: { label: string; href: string } | undefined;
  /** Top-right: the notification bell, a signed-in address. */
  utilities?: React.ReactNode;
  tone?: SurfaceTone;
  children: React.ReactNode;
}

/**
 * Per-surface treatment.
 *
 * Deliberately a small, closed table rather than class names threaded through
 * from three layouts: the surfaces have to stay *consistently* different, and
 * that only holds if the difference is stated once.
 */
const TONE: Record<SurfaceTone, { rail: string; edge: string; mast: string }> = {
  agency: {
    rail: 'bg-surface',
    edge: 'border-line',
    mast: 'text-ink',
  },
  // The plainest of the three. A client sees their brand and three places to
  // go; every extra affordance here is a chance to show them something that
  // belongs to the people who built it.
  client: {
    rail: 'bg-surface',
    edge: 'border-line',
    mast: 'text-ink',
  },
  // Operating the product, not using it. Carried over from the admin header
  // this replaced, for the same reason it was chosen there.
  ops: {
    rail: 'bg-surface-sunken',
    edge: 'border-line-strong',
    mast: 'text-ink',
  },
};

export function AppShell({
  brand,
  groups,
  action,
  utilities,
  tone = 'agency',
  children,
}: AppShellProps) {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const skin = TONE[tone];

  const flat = groups.flatMap((group) => group.items);
  const activeHref = bestMatch(pathname, flat);

  // Close the drawer on navigation. Without this it stays open over the page
  // the person just asked for, which reads as the tap not having worked.
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const rail = (
    <RailContent
      brand={brand}
      groups={groups}
      action={action}
      activeHref={activeHref}
      skin={skin}
    />
  );

  return (
    <div className="min-h-dvh bg-canvas lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      {/* `minmax(0,1fr)` rather than `1fr`: a wide table or a long unbroken
          string in the page would otherwise stretch the grid track and push
          the rail off-screen. */}

      <aside
        className={cn(
          'hidden border-r lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col',
          skin.rail,
          skin.edge,
        )}
      >
        {rail}
      </aside>

      <MobileDrawer open={open} onClose={() => setOpen(false)} skin={skin}>
        {rail}
      </MobileDrawer>

      <div className="flex min-w-0 flex-col">
        <div
          className={cn(
            'sticky top-0 z-30 flex items-center gap-3 border-b py-2 backdrop-blur',
            // The same gutter the pages use. It matters now that a page fills
            // the column instead of centring inside it: with the bar on `px-4`
            // and the page on `sm:px-6`, the bell sat eight pixels outside the
            // content's right edge on every screen above `sm`.
            'px-4 sm:px-6',
            'bg-canvas/85',
            skin.edge,
          )}
        >
          <button
            type="button"
            aria-expanded={open}
            aria-controls="app-shell-drawer"
            onClick={() => setOpen(true)}
            className={cn(
              'inline-flex items-center gap-2 rounded border px-2.5 py-1.5 lg:hidden',
              'text-sm font-medium text-ink-secondary hover:bg-surface-sunken hover:text-ink',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              skin.edge,
            )}
          >
            <MenuIcon />
            Menu
          </button>

          {/* The tenant's name stays visible on a phone, where the rail that
              normally carries it is behind the button. */}
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink lg:hidden">
            {brand.label}
          </span>

          <div className="ml-auto flex shrink-0 items-center gap-2">{utilities}</div>
        </div>

        {children}
      </div>
    </div>
  );
}

/**
 * The rail's contents, rendered twice — once docked, once in the drawer.
 *
 * Written once because a navigation that differs between widths is a navigation
 * that drifts: the old implementation grouped on phones and flattened on
 * desktop, and the two had to be kept in step by hand.
 */
function RailContent({
  brand,
  groups,
  action,
  activeHref,
  skin,
}: {
  brand: AppShellProps['brand'];
  groups: ShellNavGroup[];
  action: AppShellProps['action'];
  activeHref: string | undefined;
  skin: { rail: string; edge: string; mast: string };
}) {
  return (
    <>
      <div className={cn('border-b px-4 py-3', skin.edge)}>
        <Link
          href={brand.href}
          className={cn(
            'block min-w-0 truncate rounded font-display text-base font-semibold',
            'hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
            skin.mast,
          )}
        >
          {brand.label}
        </Link>
        {brand.sublabel ? (
          <p className="mt-0.5 truncate text-xs text-ink-muted">{brand.sublabel}</p>
        ) : null}
      </div>

      {action ? (
        <div className="px-3 pt-3">
          <Link
            href={action.href}
            className={buttonClassName({ size: 'sm', className: 'w-full justify-center' })}
          >
            {action.label}
          </Link>
        </div>
      ) : null}

      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-3">
        {groups.map((group) => (
          <div key={group.label} className="mb-4 last:mb-0">
            {group.label ? (
              <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                {group.label}
              </p>
            ) : null}

            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.href}>
                  <NavLink {...item} active={item.href === activeHref} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </>
  );
}

function NavLink({ label, href, active }: ShellNavItem & { active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'block rounded px-2 py-1.5 text-sm transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        active
          ? // Weight as well as colour: the current page has to be identifiable
            // without colour perception.
            'bg-accent-soft font-semibold text-accent'
          : 'text-ink-secondary hover:bg-surface-sunken hover:text-ink',
      )}
    >
      {label}
    </Link>
  );
}

/**
 * The rail as an overlay, below `lg`.
 *
 * A native `<dialog>` opened with `showModal()`, for the reason the design
 * system's own `Dialog` gives: the platform hands over focus containment,
 * `Escape`, an inert background and top-layer stacking, and every one of those
 * is something a hand-rolled overlay gets subtly wrong. A drawer that covers
 * the page and must be dismissed *is* modal, whatever it is called.
 *
 * `Dialog` itself is not reused here only because it is shaped for a centered
 * panel with fixed title chrome; a drawer is flush to the edge and full height.
 */
function MobileDrawer({
  open,
  onClose,
  skin,
  children,
}: {
  open: boolean;
  onClose: () => void;
  skin: { rail: string; edge: string; mast: string };
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      id="app-shell-drawer"
      ref={ref}
      aria-label="Main navigation"
      // `cancel` is Escape. Routed through the caller's handler so its state
      // cannot drift out of step with the element's.
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // The element fills the viewport, so a click on it rather than on its
        // contents is a click on the backdrop.
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        'h-dvh max-h-none w-[16rem] max-w-[85vw] border-r p-0 lg:hidden',
        // Flush left instead of centered, which is the one thing the native
        // element's default placement gets wrong for a drawer.
        'mr-auto ml-0',
        'text-ink backdrop:bg-ink/40',
        skin.rail,
        skin.edge,
      )}
    >
      <div className="flex h-full flex-col">{children}</div>
    </dialog>
  );
}

function MenuIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      className="size-4"
      aria-hidden="true"
    >
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}
