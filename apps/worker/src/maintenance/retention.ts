import { clock } from '@orbit/core';
import { systemContext } from '@orbit/auth';
import { platformDb, withTenant } from '@orbit/db';
import { logger } from '@orbit/observability';
import { deleteObject } from '@orbit/storage';

/**
 * Retention and cleanup (T3.6, SRS §26, §40).
 *
 * The only task in the product that deletes data a person did not ask to
 * delete, which is why every choice here leans the same way: **when in doubt,
 * keep it.**
 *
 * ## What is removed, and what is deliberately not
 *
 * | Removed | Kept, always |
 * |---|---|
 * | `PostAnalytics` older than the retention window | The `Post` and `PostVariant` they measured |
 * | `AnalyticsSnapshot` older than the window | `PublishingJob` / `PublishingAttempt` — the publishing record |
 * | `Report` rows past `expiresAt`, and their S3 objects | `AuditLog` — the trail must outlive what it describes |
 *
 * A post whose analytics have aged out still exists, still shows when it
 * published and where; it simply has no figures from over a year ago. Nothing
 * here touches content, publishing history, or the audit log.
 *
 * ## Tenant isolation
 *
 * The sweep is platform-wide, but **every delete runs through the tenant-scoped
 * client**. The unscoped read selects organization ids and nothing else — the
 * same bootstrap the job processors use (**D-021**) — and each tenant's rows
 * are then removed inside its own context, where RLS applies. A bug in the
 * predicate therefore cannot reach across a tenant boundary; it can only fail
 * to delete.
 *
 * ## Idempotence
 *
 * Everything here is safe to run twice, and safe to interrupt:
 * - deletes are keyed by id, so a second pass finds nothing and does nothing;
 * - the S3 object is removed **before** the row, so a crash between them leaves
 *   a row pointing at a missing object — which the next pass cleans up —
 *   rather than an orphaned object no row remembers;
 * - S3 `DELETE` on a key that is already gone succeeds, so a retry is not an
 *   error, and a failure to reach storage at all leaves the row for next time.
 */

/**
 * How long analytics are kept.
 *
 * Expressed as *calendar* months and rounded to the first of the month, which
 * retains between 13 and 14 months rather than exactly 13. That asymmetry is
 * the point: a same-period-last-year comparison must always have its
 * comparator, and the cost of keeping an extra few weeks of rows is far below
 * the cost of a report that cannot be drawn.
 */
export const ANALYTICS_RETENTION_MONTHS = 13;

/**
 * How long a private message is kept (**D-107**).
 *
 * Twelve months, decided with the owner rather than derived. A conversation is
 * correspondence with one person, and the reason to keep it — answering them,
 * and the context for the next answer — fades long before a year. The rows also
 * carry the one audience identifier Orbit stores, which is a second reason for
 * a boundary that is not "forever".
 */
export const MESSAGE_RETENTION_MONTHS = 12;

/**
 * Rows removed per statement, and organizations visited per run.
 *
 * Deleting a year of analytics for a large agency in one statement would hold
 * locks long enough to be felt by a publish happening at the same time. Small
 * batches in a loop take longer in wall-clock and are invisible to everything
 * else, which is the correct trade for work nobody is waiting on.
 */
const DELETE_BATCH = 500;
const MAX_BATCHES_PER_TABLE = 40;
const ORGANIZATIONS_PER_RUN = 200;

export interface RetentionResult {
  organizations: number;
  postAnalytics: number;
  snapshots: number;
  reports: number;
  /** Private messages past their twelve months (D-107). */
  messages: number;
  /** Conversations with nothing left in them. */
  conversations: number;
  /** What the AI assistant decided, past the same twelve months (D-108). */
  decisions: number;
  /** Objects we could not reach. The rows stay for the next pass. */
  storageFailures: number;
  /** Copilot threads, agent actions and spent OAuth codes and tokens (D-109). */
  agentRows: number;
}

/**
 * The cutoff: UTC midnight on the first of the month, thirteen months back.
 *
 * Anchoring to the first of a month avoids the trap in naive month arithmetic —
 * subtracting 13 months from the 31st lands on a day that does not exist and
 * silently rolls *forward*, which would delete more than intended. This can
 * only ever round in the direction of keeping data.
 */
export function analyticsCutoff(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - ANALYTICS_RETENTION_MONTHS, 1),
  );
}

/** The same first-of-the-month anchoring, at twelve months. */
export function messageCutoff(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - MESSAGE_RETENTION_MONTHS, 1));
}

/** How long a Copilot thread and a decided agent action are kept (D-109 §15). */
export const AGENT_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60_000;

/**
 * Agent data past its boundary (D-109).
 *
 * Copilot threads idle for 90 days and agent actions older than 90 days, plus
 * authorization codes and tokens a day past their expiry — those can no longer
 * be used by anyone, and a refresh token's reuse detection ends with its
 * lifetime anyway. Across all tenants in one statement each: these are
 * bounded, short-lived rows, and nothing in them is the client's content that
 * an audit row per organization would need to explain.
 */
export async function sweepAgentData(now: Date): Promise<number> {
  const before = new Date(now.getTime() - AGENT_RETENTION_DAYS * DAY_MS);
  const spent = new Date(now.getTime() - DAY_MS);
  const counts = await Promise.all([
    platformDb.agentThread.deleteMany({ where: { updatedAt: { lt: before } } }),
    platformDb.agentAction.deleteMany({ where: { createdAt: { lt: before } } }),
    platformDb.agentAuthorizationCode.deleteMany({ where: { expiresAt: { lt: spent } } }),
    platformDb.agentToken.deleteMany({ where: { expiresAt: { lt: spent } } }),
  ]);
  return counts.reduce((sum, { count }) => sum + count, 0);
}

export async function sweepRetention(correlationId: string): Promise<RetentionResult> {
  const now = clock.now();
  const cutoff = analyticsCutoff(now);
  const messagesBefore = messageCutoff(now);

  const result: RetentionResult = {
    organizations: 0,
    postAnalytics: 0,
    snapshots: 0,
    reports: 0,
    messages: 0,
    conversations: 0,
    decisions: 0,
    storageFailures: 0,
    agentRows: 0,
  };

  try {
    result.agentRows = await sweepAgentData(now);
  } catch (error) {
    logger.error('retention sweep failed for agent data', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Ids only, and only for organizations that actually have something to
  // remove — there is no reason to open a tenant context for an agency with
  // nothing past its boundary.
  const organizationIds = await organizationsWithExpiredData(cutoff, now, messagesBefore);
  result.organizations = organizationIds.length;

  for (const organizationId of organizationIds) {
    try {
      const swept = await sweepOrganization(
        organizationId,
        cutoff,
        now,
        messagesBefore,
        correlationId,
      );

      result.postAnalytics += swept.postAnalytics;
      result.snapshots += swept.snapshots;
      result.reports += swept.reports;
      result.messages += swept.messages;
      result.conversations += swept.conversations;
      result.decisions += swept.decisions;
      result.storageFailures += swept.storageFailures;
    } catch (error) {
      // One organization's failure must not abandon the rest of the sweep, and
      // nothing here is urgent enough to be worth retrying immediately — the
      // next scheduled pass finds the same rows.
      logger.error('retention sweep failed for one organization', {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (
    result.postAnalytics > 0 ||
    result.snapshots > 0 ||
    result.reports > 0 ||
    result.messages > 0 ||
    result.conversations > 0 ||
    result.decisions > 0 ||
    result.agentRows > 0
  ) {
    logger.info('retention sweep complete', { ...result, cutoff: cutoff.toISOString() });
  }

  return result;
}

/**
 * Which tenants have anything past a boundary.
 *
 * Three cheap `findMany`s with `distinct`, rather than one query per
 * organization: on a platform with hundreds of tenants and expired data in
 * three, this visits three.
 */
async function organizationsWithExpiredData(
  cutoff: Date,
  now: Date,
  messagesBefore: Date,
): Promise<string[]> {
  const [analytics, snapshots, reports, messages, conversations, decisions] = await Promise.all([
    platformDb.postAnalytics.findMany({
      where: { capturedAt: { lt: cutoff } },
      select: { organizationId: true },
      distinct: ['organizationId'],
      take: ORGANIZATIONS_PER_RUN,
    }),
    platformDb.analyticsSnapshot.findMany({
      where: { date: { lt: cutoff } },
      select: { organizationId: true },
      distinct: ['organizationId'],
      take: ORGANIZATIONS_PER_RUN,
    }),
    platformDb.report.findMany({
      where: { expiresAt: { lt: now } },
      select: { organizationId: true },
      distinct: ['organizationId'],
      take: ORGANIZATIONS_PER_RUN,
    }),
    platformDb.socialMessage.findMany({
      where: { sentAt: { lt: messagesBefore } },
      select: { organizationId: true },
      distinct: ['organizationId'],
      take: ORGANIZATIONS_PER_RUN,
    }),
    platformDb.socialConversation.findMany({
      where: { lastMessageAt: { lt: messagesBefore } },
      select: { organizationId: true },
      distinct: ['organizationId'],
      take: ORGANIZATIONS_PER_RUN,
    }),
    platformDb.assistantDecision.findMany({
      where: { createdAt: { lt: messagesBefore } },
      select: { organizationId: true },
      distinct: ['organizationId'],
      take: ORGANIZATIONS_PER_RUN,
    }),
  ]);

  return [
    ...new Set(
      [...analytics, ...snapshots, ...reports, ...messages, ...conversations, ...decisions].map(
        (row) => row.organizationId,
      ),
    ),
  ].slice(0, ORGANIZATIONS_PER_RUN);
}

interface OrganizationSweep {
  postAnalytics: number;
  snapshots: number;
  reports: number;
  messages: number;
  conversations: number;
  decisions: number;
  storageFailures: number;
}

async function sweepOrganization(
  organizationId: string,
  cutoff: Date,
  now: Date,
  messagesBefore: Date,
  correlationId: string,
): Promise<OrganizationSweep> {
  const ctx = systemContext({
    organizationId,
    actorName: 'retention-worker',
    // No permission is needed to delete on the tenant's behalf: this is a
    // system context, and the capability list is what the RBAC layer checks for
    // *actions*, not the mechanism that scopes the client. It holds none.
    capabilities: [],
    correlationId,
  });

  const swept: OrganizationSweep = {
    postAnalytics: 0,
    snapshots: 0,
    reports: 0,
    messages: 0,
    conversations: 0,
    decisions: 0,
    storageFailures: 0,
  };

  swept.postAnalytics = await deleteInBatches(async () => {
    const rows = await withTenant(ctx, (db) =>
      db.postAnalytics.findMany({
        where: { capturedAt: { lt: cutoff } },
        select: { id: true },
        take: DELETE_BATCH,
      }),
    );

    if (rows.length === 0) return 0;

    const { count } = await withTenant(ctx, (db) =>
      db.postAnalytics.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } }),
    );

    return count;
  });

  swept.snapshots = await deleteInBatches(async () => {
    const rows = await withTenant(ctx, (db) =>
      db.analyticsSnapshot.findMany({
        where: { date: { lt: cutoff } },
        select: { id: true },
        take: DELETE_BATCH,
      }),
    );

    if (rows.length === 0) return 0;

    const { count } = await withTenant(ctx, (db) =>
      db.analyticsSnapshot.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } }),
    );

    return count;
  });

  const reports = await sweepReports(ctx, now);
  swept.reports = reports.deleted;
  swept.storageFailures = reports.storageFailures;

  /**
   * Private messages (D-107): whole conversations first, then the old end of
   * the ones still going.
   *
   * A conversation whose latest message is past the boundary has nothing in it
   * worth keeping, and deleting it takes its messages with it. One that is still
   * active keeps its recent messages and loses only what is older than a year,
   * so a long-running conversation is trimmed rather than erased.
   */
  swept.conversations = await deleteInBatches(async () => {
    const rows = await withTenant(ctx, (db) =>
      db.socialConversation.findMany({
        where: { lastMessageAt: { lt: messagesBefore } },
        select: { id: true },
        take: DELETE_BATCH,
      }),
    );

    if (rows.length === 0) return 0;

    const { count } = await withTenant(ctx, (db) =>
      db.socialConversation.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } }),
    );

    return count;
  });

  swept.messages = await deleteInBatches(async () => {
    const rows = await withTenant(ctx, (db) =>
      db.socialMessage.findMany({
        where: { sentAt: { lt: messagesBefore } },
        select: { id: true },
        take: DELETE_BATCH,
      }),
    );

    if (rows.length === 0) return 0;

    const { count } = await withTenant(ctx, (db) =>
      db.socialMessage.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } }),
    );

    return count;
  });

  // What the assistant said goes with the messages it answered. A decision in
  // a conversation still running ages out on its own date.
  swept.decisions = await deleteInBatches(async () => {
    const rows = await withTenant(ctx, (db) =>
      db.assistantDecision.findMany({
        where: { createdAt: { lt: messagesBefore } },
        select: { id: true },
        take: DELETE_BATCH,
      }),
    );

    if (rows.length === 0) return 0;

    const { count } = await withTenant(ctx, (db) =>
      db.assistantDecision.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } }),
    );

    return count;
  });

  if (
    swept.postAnalytics > 0 ||
    swept.snapshots > 0 ||
    swept.reports > 0 ||
    swept.messages > 0 ||
    swept.conversations > 0 ||
    swept.decisions > 0
  ) {
    // On the tenant's own trail, so an agency asked "where did last year's
    // numbers go" has an answer that names the run (**D-046**). Written
    // unscoped for the same reason the other worker audit rows are: the
    // organization is known and stated, and there is no user to attribute it to.
    await platformDb.auditLog.create({
      data: {
        organizationId,
        actorUserId: null,
        actorType: 'WORKER',
        action: 'retention.swept',
        resourceType: 'Organization',
        resourceId: organizationId,
        after: {
          postAnalytics: swept.postAnalytics,
          analyticsSnapshots: swept.snapshots,
          reports: swept.reports,
          socialMessages: swept.messages,
          socialConversations: swept.conversations,
          assistantDecisions: swept.decisions,
          cutoff: cutoff.toISOString(),
          messageCutoff: messagesBefore.toISOString(),
        },
        correlationId,
      },
    });
  }

  return swept;
}

/**
 * Expired reports: the object first, then the row.
 *
 * That order is what makes an interrupted run recoverable. Deleting the row
 * first would leave an object in the bucket that nothing remembers — invisible,
 * permanent, and billed. This way a crash leaves a row pointing at a key that
 * is already gone, and the next pass finishes the job.
 */
async function sweepReports(
  ctx: ReturnType<typeof systemContext>,
  now: Date,
): Promise<{ deleted: number; storageFailures: number }> {
  let deleted = 0;
  let storageFailures = 0;

  for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch++) {
    const expired = await withTenant(ctx, (db) =>
      db.report.findMany({
        where: { expiresAt: { lt: now } },
        select: { id: true, storageKey: true },
        take: DELETE_BATCH,
      }),
    );

    if (expired.length === 0) break;

    const removable: string[] = [];

    for (const report of expired) {
      if (report.storageKey) {
        try {
          await deleteObject(report.storageKey);
        } catch (error) {
          // A missing object is not an error — S3 returns success for a key
          // that is already gone — so reaching here means storage itself is
          // unreachable. Leave the row: it is the only record that the object
          // may still exist, and losing it would orphan the object forever.
          storageFailures += 1;
          logger.warn('could not remove a report object; leaving the row for the next pass', {
            reportId: report.id,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }

      removable.push(report.id);
    }

    if (removable.length === 0) break;

    const { count } = await withTenant(ctx, (db) =>
      db.report.deleteMany({ where: { id: { in: removable } } }),
    );

    deleted += count;

    // A short batch means the table is drained; anything left is a row whose
    // object could not be reached, and looping again would only retry it.
    if (expired.length < DELETE_BATCH) break;
  }

  return { deleted, storageFailures };
}

/**
 * Run a batched delete until it stops finding rows.
 *
 * Bounded by `MAX_BATCHES_PER_TABLE` so one enormous tenant cannot monopolise a
 * run: what is left is found again on the next pass, and housekeeping that
 * finishes late is better than housekeeping that starves everything else.
 */
async function deleteInBatches(step: () => Promise<number>): Promise<number> {
  let total = 0;

  for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch++) {
    const count = await step();
    total += count;
    if (count < DELETE_BATCH) break;
  }

  return total;
}
