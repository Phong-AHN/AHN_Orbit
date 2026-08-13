/**
 * The permission catalogue (docs/RBAC.md §4).
 *
 * Named `resource:action`. Adding one here without adding it to the grant
 * matrix makes it deny-by-default for every role — which is the correct failure
 * mode, and is asserted by a test.
 */

export const PERMISSIONS = [
  // ── Organization & members ────────────────────────────────────────────────
  'org:read',
  'org:update',
  'org:delete',
  'org:transfer_ownership',
  'org:suspend',
  'member:invite',
  'member:list',
  'member:update_role',
  'member:remove',
  'audit:read',

  // ── Workspace & brand ─────────────────────────────────────────────────────
  'workspace:create',
  'workspace:read',
  'workspace:update',
  'workspace:delete',
  'workspace:manage_members',
  'brand:create',
  'brand:read',
  'brand:update',
  'brand:delete',
  'brand_voice:read',
  'brand_voice:update',

  // ── Social accounts ───────────────────────────────────────────────────────
  'social_account:connect',
  'social_account:read',
  'social_account:reconnect',
  'social_account:disconnect',
  /**
   * Held by NO role, at any privilege level, including platform admins.
   * Decryption happens only inside the provider layer, in the worker, in
   * memory. This entry exists so that fact is explicit and testable
   * (docs/RBAC.md §4.3).
   */
  'social_credential:read_plaintext',

  // ── Content & publishing ──────────────────────────────────────────────────
  'post:create',
  'post:read',
  'post:update',
  'post:delete',
  'post:assign',
  'post:submit_internal_review',
  'post:approve_internal',
  'post:submit_client_review',
  'post:approve_client',
  'post:request_changes',
  'post:schedule',
  'post:reschedule',
  'post:publish_now',
  'post:cancel_scheduled',
  'post:retry_failed',
  'post:delete_published_remote',

  // ── Collaboration ─────────────────────────────────────────────────────────
  'comment:create',
  'comment:read_internal',
  'comment:resolve',

  // ── Media ─────────────────────────────────────────────────────────────────
  'media:upload',
  'media:read',
  'media:update',
  'media:delete',

  // ── Analytics, reporting, AI ──────────────────────────────────────────────
  'analytics:read',
  'report:generate',
  'report:export',
  'ai:generate',
  'ai:view_usage',

  // ── Billing ───────────────────────────────────────────────────────────────
  'billing:read',
  'billing:manage',

  // ── Platform administration ───────────────────────────────────────────────
  'admin:view_jobs',
  'admin:retry_job',
  'admin:view_system_logs',
  'admin:impersonate',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

/**
 * Permissions that describe operating the platform itself rather than acting
 * inside a tenant. Only `isPlatformAdmin` grants these, and they never confer
 * access to client content (docs/RBAC.md §1 rule 4).
 */
export const PLATFORM_PERMISSIONS = [
  'org:suspend',
  'admin:view_jobs',
  'admin:retry_job',
  'admin:view_system_logs',
  'admin:impersonate',
] as const satisfies readonly Permission[];

/** Permissions no principal may ever hold. */
export const UNGRANTABLE_PERMISSIONS = [
  'social_credential:read_plaintext',
] as const satisfies readonly Permission[];
