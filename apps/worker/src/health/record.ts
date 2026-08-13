import {
  NotFoundError,
  classifyHealthChange,
  type HealthChange,
  type SocialAccountStatus,
  type TenantContext,
} from '@orbit/core';
import { withTenant, type TenantDb } from '@orbit/db';
import { notify } from '@orbit/notifications';

/**
 * Recording what we learned about an account (T1.7).
 *
 * The **only** place in the worker that writes account health, deliberately:
 * two things discover a broken connection — the hourly probe and a publish that
 * comes back unauthenticated — and both must produce exactly the same stored
 * consequence. If they diverged, an account could be `NEEDS_RECONNECT` with no
 * notification, or notified without being demoted, and either would be worse
 * than the original failure.
 *
 * The status change, the notifications and the audit row all commit together.
 * `withTenant` is a transaction, so there is no window in which an account is
 * marked broken but nobody has been told. That is why `notify` takes a `db`
 * handle rather than opening its own (T1.15).
 */

export interface HealthVerdict {
  status: SocialAccountStatus;
  /** A safe explanation. Never provider JSON, never token material. */
  message?: string | null | undefined;
  /** Scopes the provider says we hold. Omitted when the verdict came from a publish. */
  grantedScopes?: readonly string[] | undefined;
  checkedAt: Date;
}

export interface RecordHealthInput {
  ctx: TenantContext;
  socialAccountId: string;
  verdict: HealthVerdict;
  correlationId: string;
  /** What discovered this. Kept on the audit row so the trail explains itself. */
  source: 'health-probe' | 'publish';
}

export async function recordHealthVerdict(input: RecordHealthInput): Promise<HealthChange> {
  const { verdict } = input;

  return withTenant(input.ctx, async (db) => {
    const account = await db.socialAccount.findFirst({
      where: { id: input.socialAccountId, deletedAt: null },
      select: {
        id: true,
        status: true,
        displayName: true,
        platform: true,
        workspaceId: true,
        brandId: true,
      },
    });

    if (!account) throw new NotFoundError('Social account');

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

    // Only transitions are news. Without this guard an account that stays broken
    // would generate a notification every hour and an audit row every hour,
    // burying the one line that says when it actually broke.
    if (change.changed) {
      await writeAudit(db, input, account, change);
    }

    if (change.degraded || change.recovered) {
      await notifyHealthChange(db, input, account, verdict);
    }

    return change;
  });
}

type AccountRow = {
  id: string;
  status: SocialAccountStatus;
  displayName: string;
  workspaceId: string;
  brandId: string;
};

async function writeAudit(
  db: TenantDb,
  input: RecordHealthInput,
  account: AccountRow,
  change: HealthChange,
): Promise<void> {
  await db.auditLog.create({
    data: {
      organizationId: input.ctx.organizationId,
      actorUserId: null,
      actorType: 'WORKER',
      action: change.recovered
        ? 'social_account.health_recovered'
        : 'social_account.health_degraded',
      resourceType: 'SocialAccount',
      resourceId: account.id,
      workspaceId: account.workspaceId,
      brandId: account.brandId,
      before: { status: account.status },
      // The message is the provider's safe text. No token material reaches here:
      // `probeHealth` returns a status and a sentence, never a credential.
      after: { status: input.verdict.status, source: input.source },
      correlationId: input.correlationId,
    },
  });
}

/**
 * Tell the people who can put the connection back.
 *
 * Fan-out, copy and channel selection all live in `@orbit/notifications`, so
 * this and its web-side counterpart cannot drift: recipients are derived from
 * the grant matrix once, in one place (T1.15).
 */
async function notifyHealthChange(
  db: TenantDb,
  input: RecordHealthInput,
  account: AccountRow,
  verdict: HealthVerdict,
): Promise<void> {
  await notify(db, input.ctx, {
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
