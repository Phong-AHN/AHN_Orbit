import { NotFoundError, clock, type TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';
import { logger } from '@orbit/observability';
import { capabilitiesFor, getProvider } from '@orbit/providers';
import { loadAccountCredential } from '../credentials.js';

/**
 * Pulling insights back from the platforms (T3.1, SRS §18).
 *
 * Two shapes, because the platforms have two: a *post* metric is a lifetime
 * total attached to one published thing, and an *account* metric is a figure
 * for a day. They are stored in different tables for that reason and neither is
 * derived from the other.
 *
 * **A missing metric is never a zero.** Every write carries the provider's
 * `availability` map alongside the numbers, so the UI can say "Facebook does
 * not provide this" rather than charting a nought that a client would read as
 * "nobody engaged" (SRS §18, docs/SOCIAL_PROVIDERS.md §3). This is the whole
 * reason the `availability` column exists, and it is why nothing here fills a
 * gap with a default.
 *
 * **This module only reads and stores.** It never touches a post's status, a
 * variant's state, or an account's health — an analytics poll that could change
 * publishing state would make every quota failure a publishing incident.
 */

export type IngestResult =
  | { kind: 'CAPTURED'; metrics: number; unavailable: number }
  | { kind: 'SKIPPED'; reason: 'NOT_PUBLISHED' | 'NOT_CONNECTED' | 'UNSUPPORTED' };

/** How far back an account-level poll asks for, per day-bucket write. */
const ACCOUNT_WINDOW_DAYS = 1;

/**
 * One published variant's metrics.
 *
 * Keyed by `(postVariantId, capturedAt)`, so re-running a poll writes a new
 * point rather than overwriting the last one — the history of a number is the
 * thing a report is made of, and an upsert would erase it. Two polls landing in
 * the same millisecond is the only collision, and that is the same poll twice.
 */
export async function ingestPostAnalytics(input: {
  ctx: TenantContext;
  postVariantId: string;
  correlationId: string;
}): Promise<IngestResult> {
  const { ctx, postVariantId } = input;

  const variant = await withTenant(ctx, (db) =>
    db.postVariant.findFirst({
      where: { id: postVariantId, deletedAt: null },
      select: {
        id: true,
        platform: true,
        status: true,
        externalPostId: true,
        publishedAt: true,
        socialAccount: {
          select: { id: true, externalId: true, accountType: true, status: true },
        },
      },
    }),
  );

  if (!variant) throw new NotFoundError('Post variant');

  // Nothing to measure. A variant that never published has no platform object,
  // and asking about one would be an error rather than an empty result.
  if (variant.status !== 'PUBLISHED' || !variant.externalPostId) {
    return { kind: 'SKIPPED', reason: 'NOT_PUBLISHED' };
  }

  if (variant.socialAccount.status === 'REVOKED' || variant.socialAccount.status === 'DISABLED') {
    return { kind: 'SKIPPED', reason: 'NOT_CONNECTED' };
  }

  const capabilities = capabilitiesFor(variant.platform, variant.socialAccount.accountType);
  if (!capabilities.analytics.post) return { kind: 'SKIPPED', reason: 'UNSUPPORTED' };

  const credential = await loadAccountCredential(ctx, variant.socialAccount.id);
  const provider = getProvider(variant.platform);

  const set = await provider.fetchPostAnalytics(
    { externalPostId: variant.externalPostId, accountExternalId: variant.socialAccount.externalId },
    credential,
    { from: variant.publishedAt ?? clock.now(), to: clock.now() },
  );

  await withTenant(ctx, (db) =>
    db.postAnalytics.create({
      data: {
        organizationId: ctx.organizationId,
        postVariantId: variant.id,
        capturedAt: set.capturedAt,
        metrics: set.metrics,
        availability: set.availability,
        providerApiVersion: set.apiVersion,
      },
    }),
  );

  return summarise(set);
}

/**
 * One account's figures for a day.
 *
 * Keyed by `(socialAccountId, date)` and **upserted**, which is the opposite
 * choice from posts and deliberately so: a day's number is still moving while
 * the day is open, and two rows for one date would double every total built on
 * it. The last poll of a day wins because it is the most complete.
 */
export async function ingestAccountAnalytics(input: {
  ctx: TenantContext;
  socialAccountId: string;
  correlationId: string;
}): Promise<IngestResult> {
  const { ctx, socialAccountId } = input;

  const account = await withTenant(ctx, (db) =>
    db.socialAccount.findFirst({
      where: { id: socialAccountId, deletedAt: null },
      select: { id: true, platform: true, externalId: true, accountType: true, status: true },
    }),
  );

  if (!account) throw new NotFoundError('Social account');

  if (account.status === 'REVOKED' || account.status === 'DISABLED') {
    return { kind: 'SKIPPED', reason: 'NOT_CONNECTED' };
  }

  const capabilities = capabilitiesFor(account.platform, account.accountType);
  if (!capabilities.analytics.account) return { kind: 'SKIPPED', reason: 'UNSUPPORTED' };

  const credential = await loadAccountCredential(ctx, account.id);
  const provider = getProvider(account.platform);

  const to = clock.now();
  const from = new Date(to.getTime() - ACCOUNT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const set = await provider.fetchAccountAnalytics({ externalId: account.externalId }, credential, {
    from,
    to,
  });

  // The date this row belongs to, in UTC. Day boundaries in a workspace's own
  // zone are a reporting concern, applied when the rows are read — storing them
  // pre-shifted would make one account's history unreadable if the client ever
  // moved zone.
  const date = new Date(
    Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate(), 0, 0, 0, 0),
  );

  // Explicit find-then-write rather than `upsert`: an upsert cannot be
  // tenant-scoped — its `where` targets a unique index directly, so the
  // scoped client's organization predicate has nowhere to attach — and the
  // db layer refuses one for exactly that reason.
  await withTenant(ctx, async (db) => {
    const existing = await db.analyticsSnapshot.findFirst({
      where: { socialAccountId: account.id, date },
      select: { id: true },
    });

    const values = {
      metrics: set.metrics,
      availability: set.availability,
      providerApiVersion: set.apiVersion,
    };

    if (existing) {
      await db.analyticsSnapshot.update({ where: { id: existing.id }, data: values });
      return;
    }

    await db.analyticsSnapshot.create({
      data: {
        organizationId: ctx.organizationId,
        socialAccountId: account.id,
        date,
        ...values,
      },
    });
  });

  return summarise(set);
}

function summarise(set: {
  metrics: Record<string, number>;
  availability: Record<string, string>;
}): IngestResult {
  const unavailable = Object.values(set.availability).filter((v) => v !== 'AVAILABLE').length;

  if (unavailable > 0) {
    logger.debug('some metrics were not available', {
      captured: Object.keys(set.metrics).length,
      unavailable,
    });
  }

  return { kind: 'CAPTURED', metrics: Object.keys(set.metrics).length, unavailable };
}
