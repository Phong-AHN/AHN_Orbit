'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@orbit/ui';

/**
 * The organization navigation (SRS §29).
 *
 * Given an already-filtered list — the server decides what this principal may
 * see, because the permission matrix lives there — this handles the three
 * things a navigation has to get right and the old flat row did not:
 *
 * 1. **Where am I.** The active destination is marked, by longest matching
 *    prefix so `/posts/abc` still highlights Posts, and with `aria-current` so
 *    it is announced rather than only coloured.
 * 2. **Small screens.** Eleven links do not fit on a phone. Below `lg` they
 *    collapse behind a labelled button; above it they are a bar. Nothing is
 *    hidden at any width — collapsing is not the same as dropping.
 * 3. **Structure.** Grouped in the menu, flattened in the bar: a phone has room
 *    for headings and a desktop bar does not.
 */

export interface NavGroupView {
  label: string;
  items: Array<{ label: string; href: string; exact?: boolean }>;
}

export interface OrgNavProps {
  groups: NavGroupView[];
}

export function OrgNav({ groups }: OrgNavProps) {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  // Close on navigation. Without this the sheet stays open over the page the
  // person just asked for, which reads as the tap not having worked.
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const flat = groups.flatMap((group) => group.items);
  const activeHref = bestMatch(pathname, flat);

  return (
    <>
      {/* Desktop: one scrollable bar. */}
      <nav aria-label="Main" className="hidden min-w-0 flex-1 items-center gap-0.5 lg:flex">
        {flat.map((item) => (
          <NavLink key={item.href} {...item} active={item.href === activeHref} />
        ))}
      </nav>

      {/* Mobile: a labelled disclosure. */}
      <div className="flex flex-1 items-center justify-end lg:hidden">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="org-nav-sheet"
          onClick={() => setOpen((value) => !value)}
          className={cn(
            'inline-flex items-center gap-2 rounded border border-line px-3 py-1.5',
            'text-sm font-medium text-ink-secondary hover:bg-surface-sunken hover:text-ink',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          )}
        >
          <span aria-hidden="true">☰</span>
          Menu
        </button>
      </div>

      {open ? (
        <nav
          id="org-nav-sheet"
          aria-label="Main"
          className="absolute inset-x-0 top-full z-40 border-b border-line bg-surface shadow-lg lg:hidden"
        >
          <div className="mx-auto max-w-6xl space-y-4 px-6 py-4">
            {groups.map((group) => (
              <div key={group.label}>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                  {group.label}
                </p>
                <div className="flex flex-col">
                  {group.items.map((item) => (
                    <NavLink key={item.href} {...item} active={item.href === activeHref} block />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </nav>
      ) : null}
    </>
  );
}

function NavLink({
  label,
  href,
  active,
  block,
}: {
  label: string;
  href: string;
  active: boolean;
  block?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'whitespace-nowrap rounded px-2.5 py-1.5 text-sm transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        block && 'py-2',
        active
          ? // Weight as well as colour: the current page must be identifiable
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
 * Longest matching prefix wins.
 *
 * `/orgs/x/settings/accounts` must highlight Accounts rather than Clients even
 * though both live under `/settings`, and `/posts/abc` must highlight Posts.
 * Exact items opt out, which is how Today avoids matching everything under the
 * organization root.
 */
function bestMatch(
  pathname: string,
  items: ReadonlyArray<{ href: string; exact?: boolean }>,
): string | undefined {
  let best: string | undefined;

  for (const item of items) {
    const matches = item.exact
      ? pathname === item.href
      : pathname === item.href || pathname.startsWith(`${item.href}/`);

    if (matches && (best === undefined || item.href.length > best.length)) {
      best = item.href;
    }
  }

  return best;
}
