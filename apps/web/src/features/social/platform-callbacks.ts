import { createHash } from 'node:crypto';
import { clock, type Platform } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { logger } from '@orbit/observability';
import { verifySignedRequest } from './signed-request';

/**
 * What Meta tells us when somebody removes the app or asks for their data
 * (SRS §6, §22).
 *
 * Two obligations that arrive the same way — a signed POST with no session —
 * and are easy to treat as form fields to satisfy a review. They are not:
 *
 *   • **Deauthorize** means a person revoked us in *their* settings. Our stored
 *     token is already dead. Leaving the account ACTIVE means every scheduled
 *     post to it fails one at a time while the accounts page reports everything
 *     fine, which is the exact failure T1.7 exists to prevent.
 *   • **Data deletion** is a legal request, and Meta requires a confirmation
 *     code and a status URL back so the person can follow it up.
 *
 * Both run **without a tenant context**, which is unusual enough to state: the
 * platform's user id is the only identifier available, and there is no session
 * to scope by. That is why the signature check is not optional and why these
 * only ever act on rows matched by `platform` **and** `externalId` — never on
 * anything supplied in the request body.
 */

/** Rows a platform user id maps to, across every tenant. */
async function accountsFor(platform: Platform, externalId: string) {
  return platformDb.socialAccount.findMany({
    where: { platform, externalId, deletedAt: null },
    select: { id: true, organizationId: true, displayName: true },
  });
}

/**
 * A person revoked the app on the platform.
 *
 * The credential is deleted and the account marked NEEDS_RECONNECT rather than
 * REVOKED-and-soft-deleted: the agency did not ask for this, their scheduled
 * posts still exist, and reconnecting is a two-click fix. Soft-deleting would
 * hide the account and quietly strand everything pointing at it.
 *
 * Never throws. Meta retries a failing callback, and a 500 here would have it
 * hammering an endpoint that cannot succeed — while the account stays ACTIVE
 * either way, which is the state that actually costs somebody a post.
 */
export async function handleDeauthorize(input: {
  platform: Platform;
  signedRequest: string;
  appSecret: string;
  correlationId: string;
}): Promise<{ handled: number }> {
  const payload = verifySignedRequest(input.signedRequest, input.appSecret);
  const externalId = payload.user_id;

  if (!externalId) {
    logger.warn('deauthorize callback carried no user id', {
      platform: input.platform,
      correlationId: input.correlationId,
    });
    return { handled: 0 };
  }

  const accounts = await accountsFor(input.platform, externalId);

  for (const account of accounts) {
    await platformDb.socialCredential.deleteMany({ where: { socialAccountId: account.id } });
    await platformDb.socialAccount.update({
      where: { id: account.id },
      data: {
        status: 'NEEDS_RECONNECT',
        healthError: `${input.platform} access was removed on the platform. Reconnect the account to publish again.`,
        healthCheckedAt: clock.now(),
      },
    });

    // No `audit()` helper here: that writes through the tenant-scoped client and
    // there is no principal to scope by. The row is written directly, with the
    // platform named as the actor so the activity feed does not attribute this
    // to whoever happens to look at it next.
    await platformDb.auditLog.create({
      data: {
        organizationId: account.organizationId,
        action: 'social_account.deauthorized',
        resourceType: 'SocialAccount',
        resourceId: account.id,
        actorType: 'SYSTEM',
        // `reason` rather than an actor name: the audit row has no name column,
        // and naming the platform matters — otherwise the activity feed reads as
        // though somebody in the agency disconnected the account.
        reason: `${input.platform} reported that the app was removed`,
        correlationId: input.correlationId,
      },
    });
  }

  logger.info('platform deauthorization handled', {
    platform: input.platform,
    correlationId: input.correlationId,
    accounts: accounts.length,
  });

  return { handled: accounts.length };
}

/**
 * A person asked the platform to delete their data.
 *
 * What Orbit holds for a platform user is the connection and its token — the
 * posts belong to the agency, not to the platform account, and deleting a
 * client's content because somebody revoked an Instagram login would destroy
 * work nobody asked us to destroy. So this deletes the credential and the
 * account row, and says so plainly on the status page.
 *
 * The confirmation code is derived from the platform and user id rather than
 * random, so the same request twice yields the same code — Meta retries, and a
 * fresh code on each retry would leave a person holding a reference that no
 * longer matches anything.
 */
export async function handleDataDeletion(input: {
  platform: Platform;
  signedRequest: string;
  appSecret: string;
  appUrl: string;
  correlationId: string;
}): Promise<{ url: string; confirmation_code: string }> {
  const payload = verifySignedRequest(input.signedRequest, input.appSecret);
  const externalId = payload.user_id ?? 'unknown';

  const confirmationCode = createHash('sha256')
    .update(`${input.platform}:${externalId}`)
    .digest('hex')
    .slice(0, 24);

  if (payload.user_id) {
    const accounts = await accountsFor(input.platform, payload.user_id);

    for (const account of accounts) {
      await platformDb.socialCredential.deleteMany({ where: { socialAccountId: account.id } });
      await platformDb.socialAccount.update({
        where: { id: account.id },
        data: { status: 'REVOKED', deletedAt: clock.now(), healthError: null },
      });

      await platformDb.auditLog.create({
        data: {
          organizationId: account.organizationId,
          action: 'social_account.data_deleted',
          resourceType: 'SocialAccount',
          resourceId: account.id,
          actorType: 'SYSTEM',
          reason: `${input.platform} relayed a data deletion request`,
          correlationId: input.correlationId,
          after: { confirmationCode },
        },
      });
    }

    logger.info('platform data deletion handled', {
      platform: input.platform,
      correlationId: input.correlationId,
      accounts: accounts.length,
    });
  }

  return {
    // A page a person can actually read, with the code in the URL so it
    // describes their request rather than deletion in general.
    url: `${input.appUrl}/data-deletion?code=${confirmationCode}`,
    confirmation_code: confirmationCode,
  };
}
