import { type TenantContext, accessibleWorkspaceIds } from '@orbit/core';
import { withTenant } from '@orbit/db';

/**
 * Reading the audit log as an activity feed (SRS §41).
 *
 * The rows have been written since T0.6 and nothing has ever read them outside
 * of tests. That is a real gap: an audit trail nobody can see does not answer
 * "who changed this and when", which is the question an agency gets from its
 * client, in writing, at the worst possible moment.
 *
 * **This is a read and only a read.** No mutation, no redaction pass, no
 * deletion — the value of the trail is that it is append-only, and the surface
 * that displays it must not be the one that could edit it.
 *
 * Scope follows the role. `audit:read` is ORG for Owner/Admin and WORKSPACE for
 * an Account Manager, so a manager sees their own workspaces' rows and not the
 * organization-wide ones — an org-level row (`workspaceId: null`) is about the
 * agency itself, and a workspace grant is not a grant over the agency.
 */

const ACTIVITY_SELECT = {
  id: true,
  action: true,
  actorType: true,
  resourceType: true,
  resourceId: true,
  workspaceId: true,
  brandId: true,
  reason: true,
  createdAt: true,
  actorUser: { select: { id: true, name: true, email: true } },
} as const;

export interface ActivityFilter {
  /** Narrow to one post, brand, or account — the "history of this thing" view. */
  resourceId?: string;
  resourceType?: string;
  workspaceId?: string;
  limit?: number;
  /** Keyset pagination: rows strictly older than this id. */
  before?: string;
}

export async function listActivity(ctx: TenantContext, filter: ActivityFilter = {}) {
  const accessible = accessibleWorkspaceIds(ctx);
  const limit = Math.min(filter.limit ?? 50, 100);

  const rows = await withTenant(ctx, (db) =>
    db.auditLog.findMany({
      where: {
        ...(accessible === 'ALL'
          ? {}
          : // A workspace-scoped reader sees their workspaces' rows. Rows with
            // no workspace are organization-level and stay out.
            { workspaceId: { in: [...accessible] } }),
        ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
        ...(filter.resourceId ? { resourceId: filter.resourceId } : {}),
        ...(filter.resourceType ? { resourceType: filter.resourceType } : {}),
        // uuid_generate_v7 is time-ordered, so id ordering *is* time ordering
        // and a keyset page cannot skip or repeat a row the way an offset can
        // when the feed is being written to while somebody reads it.
        ...(filter.before ? { id: { lt: filter.before } } : {}),
      },
      select: ACTIVITY_SELECT,
      orderBy: { id: 'desc' },
      take: limit + 1,
    }),
  );

  return {
    entries: rows.slice(0, limit),
    nextCursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null,
  };
}
