import type { Permission } from '@orbit/rbac';

/**
 * What each role sees, and where (SRS §5, §29).
 *
 * Navigation is **derived from the permission matrix**, not hand-written per
 * role. That is the whole design: a permission added to a role tomorrow shows
 * the destination automatically, and a destination whose permission somebody
 * lacks does not appear at all. Hiding a link is not a security control — the
 * route and the API check independently — but a menu full of things that would
 * refuse you is a menu that makes the product feel like somebody else's.
 *
 * Grouped rather than flat. Eleven destinations in one row is a list; four
 * groups of two or three is a structure a person can hold in their head.
 */

export interface NavItem {
  label: string;
  /** Appended to `/orgs/{slug}`. */
  path: string;
  /** Shown only when the principal holds this. Omitted ⇒ always shown. */
  permission?: Permission;
  /** Longest-prefix matching handles nested routes; this marks exact-only. */
  exact?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * The groups, in the order the day runs.
 *
 * **Work** is what somebody opens the product to do. **Clients** is the account
 * side. **Insight** is looking back. **Settings** is the plumbing, last because
 * it is visited least — and because putting Team next to Posts is what makes a
 * navigation feel arbitrary.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: 'Work',
    items: [
      { label: 'Today', path: '/dashboard', exact: true },
      { label: 'Posts', path: '/posts', permission: 'post:read' },
      // Beside Posts rather than under an AI heading: most ideas are typed by a
      // person in a planning meeting.
      { label: 'Ideas', path: '/ideas', permission: 'post:read' },
      { label: 'Calendar', path: '/calendar', permission: 'post:read' },
      // Shown to whoever can act on a review — internally or on the client's
      // behalf. An Approver's whole job is this page.
      { label: 'Approvals', path: '/approvals', permission: 'post:approve_internal' },
      // Under Work rather than Insight: answering the audience is something
      // somebody does today, not something they look back on.
      { label: 'Community', path: '/community', permission: 'comment:read_public' },
    ],
  },
  {
    label: 'Clients',
    items: [
      { label: 'Clients', path: '/settings/workspaces', permission: 'workspace:read' },
      { label: 'Accounts', path: '/settings/accounts', permission: 'social_account:read' },
      { label: 'Media', path: '/media', permission: 'media:read' },
    ],
  },
  {
    label: 'Insight',
    items: [
      { label: 'Analytics', path: '/analytics', permission: 'analytics:read' },
      { label: 'Publishing', path: '/publishing', permission: 'post:read' },
      { label: 'Activity', path: '/activity', permission: 'audit:read' },
    ],
  },
  {
    label: 'Settings',
    items: [{ label: 'Team', path: '/settings/members', permission: 'member:list' }],
  },
];

/**
 * The client portal's navigation (SRS §21, D-012).
 *
 * No permissions attached, and that is not an oversight: reaching the portal at
 * all already means being a Client of this workspace, and all three
 * destinations are the same three questions every client has — what needs me,
 * what is coming, what went out. A permission-filtered portal would be a portal
 * that sometimes has one link in it.
 *
 * One unlabelled group, because three items do not need a heading to be
 * understood and a heading over all of them would say "Navigation".
 */
export const PORTAL_NAV: readonly NavGroup[] = [
  {
    label: '',
    items: [
      // Exact: this is the workspace root, so as a prefix it would match every
      // other portal page and mark itself active on all of them.
      { label: 'To review', path: '', exact: true },
      { label: 'Upcoming', path: '/upcoming' },
      { label: 'Published', path: '/published' },
    ],
  },
];

/**
 * The platform operations navigation (SRS §28).
 *
 * Ungated here because the gate is the surface: `requirePlatformAdmin` has
 * already run in the layout and in every page, and there is one kind of
 * principal on the other side of it. Grouped because operating the product and
 * looking at who uses it are different jobs.
 */
export const ADMIN_NAV: readonly NavGroup[] = [
  {
    label: 'Operations',
    items: [
      { label: 'Health', path: '', exact: true },
      { label: 'Dead letters', path: '/jobs' },
    ],
  },
  {
    label: 'Tenants',
    items: [
      { label: 'Organizations', path: '/organizations' },
      { label: 'Users', path: '/users' },
      { label: 'Connections', path: '/accounts' },
    ],
  },
];

/**
 * Turn a surface's declaration into what the shell renders.
 *
 * Here rather than in each layout because all three were about to grow their
 * own copy of "prefix the path, carry `exact` across, drop the empty groups" —
 * and the third copy is where they start to differ.
 *
 * `allowed` decides visibility. The agency passes the permission check; the
 * portal and operations pass nothing, because their gate is the surface itself.
 */
export function shellGroups(
  base: string,
  declaration: readonly NavGroup[],
  allowed: (permission: Permission) => boolean = () => true,
): Array<{ label: string; items: Array<{ label: string; href: string; exact?: boolean }> }> {
  return declaration
    .map((group) => ({
      label: group.label,
      items: group.items
        .filter((item) => !item.permission || allowed(item.permission))
        .map((item) => ({
          label: item.label,
          // A destination at the surface root has an empty path, and `${base}`
          // is already the href — appending nothing is correct, but it has to
          // not become a trailing slash, which would never match the pathname.
          href: `${base}${item.path}`,
          ...(item.exact ? { exact: true as const } : {}),
        })),
    }))
    .filter((group) => group.items.length > 0);
}

/**
 * The single most useful thing this role can do next.
 *
 * A header with a primary action is a header that answers "what should I do
 * now" without the person having to scan a menu — and the answer genuinely
 * differs by role. An Approver has nothing to create; their work arrives.
 */
export interface PrimaryAction {
  label: string;
  path: string;
  permission: Permission;
}

export const PRIMARY_ACTIONS: readonly PrimaryAction[] = [
  { label: 'New post', path: '/posts/new', permission: 'post:create' },
  // Falls through to whoever cannot create: reviewing is their primary verb.
  { label: 'Review queue', path: '/approvals', permission: 'post:approve_internal' },
];
