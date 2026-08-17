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
