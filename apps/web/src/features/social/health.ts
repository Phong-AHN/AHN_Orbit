import {
  classifyHealthChange,
  type HealthChange,
  type SocialAccountStatus,
  type TenantContext,
} from '@orbit/core';
import type { TenantDb } from '@orbit/db';
import { notify } from '@orbit/notifications';
import { audit } from '@/server/audit';

/**
 * Recording a health verdict from the web side (T1.7).
 *
 * The counterpart of `apps/worker/src/health/record.ts`. The two processes
 * cannot import each other's code, so the *shape* exists twice — but everything
 * that could drift dangerously now lives in one place: recipient resolution,
 * notification copy and channel selection are all `@orbit/notifications`, and
 * the health decisions are `@orbit/core` (T1.15 removed the duplicated fan-out
 * that T1.7 shipped with).
 *
 * What remains duplicated is the status update and the audit row, and the audit
 * row is *meant* to differ: here a person asked for the check, so it names them;
 * in the worker it is `WORKER`.
 */

export interface HealthVerdict {
  status: SocialAccountStatus;
  /** A safe explanation. Never provider JSON, never token material. */
  message?: string | null | undefined;
  grantedScopes?: readonly string[] | undefined;
  checkedAt: Date;
}

export interface AccountForHealth {
  id: string;
  status: SocialAccountStatus;
  displayName: string;
  workspaceId: string;
  brandId: string;
}

/**
 * Apply a verdict to an account, inside the caller's transaction.
 *
 * Takes the `db` handle rather than opening its own, so the status change, the
 * notifications and the audit row commit together. There is no window in which
 * an account is marked broken and nobody has been told.
 */
export async function applyHealthVerdict(
  db: TenantDb,
  ctx: TenantContext,
  account: AccountForHealth,
  verdict: HealthVerdict,
): Promise<HealthChange> {
  const change = classifyHealthChange(account.status, verdict.status);

  await db.socialAccount.update({
    where: { id: account.id },
    data: {
      status: verdict.status,
      healthCheckedAt: verdict.checkedAt,
      // A healthy account carries no error. Leaving the old text behind would
      // have the UI explaining a problem that no longer exists.
      healthError: verdict.status === 'ACTIVE' ? null : (verdict.message ?? null),
      ...(verdict.grantedScopes ? { scopes: [...verdict.grantedScopes] } : {}),
    },
  });

  // Only transitions are news. Auditing every probe would bury the one line
  // that says when the account actually broke under a row per check.
  if (change.changed) {
    await audit(db, ctx, {
      action: change.recovered
        ? 'social_account.health_recovered'
        : 'social_account.health_degraded',
      resourceType: 'SocialAccount',
      resourceId: account.id,
      workspaceId: account.workspaceId,
      brandId: account.brandId,
      before: { status: account.status },
      after: { status: verdict.status, source: 'health-probe' },
    });
  }

  if (change.degraded || change.recovered) {
    await notify(db, ctx, {
      event:
        verdict.status === 'ACTIVE'
          ? { type: 'social_account.reconnected', accountName: account.displayName }
          : {
              type: 'social_account.needs_reconnect',
              accountName: account.displayName,
              reason: verdict.message,
            },
      resource: {
        resourceType: 'SocialAccount',
        resourceId: account.id,
        workspaceId: account.workspaceId,
        brandId: account.brandId,
      },
    });
  }

  return change;
}
