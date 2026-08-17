import {
  NotFoundError,
  ValidationError,
  clock,
  isUserPrincipal,
  type TenantContext,
} from '@orbit/core';
import { withTenant } from '@orbit/db';
import { enqueue } from '@orbit/queue';
import { assertKeyBelongsTo, presignDownload } from '@orbit/storage';
import { audit, type AuditInput } from '@/server/audit';
import type { CreateReportInput } from './contracts';

/**
 * Client reports (T3.5, SRS §19).
 *
 * A report is generated asynchronously, stored in S3, and handed back only as a
 * short-lived signed URL. Three rules hold the security of that arrangement,
 * and each is enforced here rather than at the surface:
 *
 * 1. **The storage key never leaves the server.** `REPORT_SELECT` omits it, so
 *    a route cannot leak it by forgetting to strip a field — it was never in
 *    the object to begin with.
 * 2. **The parameters are written at request time**, when the caller's
 *    permission was checked, and the job carries only the row id. A render can
 *    therefore never cover a wider range than the one that was authorised.
 * 3. **Expiry is enforced on read**, not merely recorded. A lapsed report is
 *    refused even though its row and its object may both still exist.
 */

/** How long a rendered report stays downloadable. */
const REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** How long a signed download URL lives once issued. */
const DOWNLOAD_URL_TTL_SECONDS = 300;

/**
 * The shape a client is allowed to see.
 *
 * `storageKey` is deliberately absent — it is the one field that would turn a
 * report id into a way to reach an object directly, and the safest way to keep
 * it out of a response is to keep it out of the query.
 */
const REPORT_SELECT = {
  id: true,
  status: true,
  format: true,
  parameters: true,
  sizeBytes: true,
  failureMessage: true,
  expiresAt: true,
  workspaceId: true,
  createdAt: true,
  updatedAt: true,
  requestedBy: { select: { id: true, name: true, email: true } },
} as const;

export async function listReports(ctx: TenantContext, filter: { limit?: number } = {}) {
  return withTenant(ctx, (db) =>
    db.report.findMany({
      select: REPORT_SELECT,
      orderBy: { createdAt: 'desc' },
      take: Math.min(filter.limit ?? 25, 100),
    }),
  );
}

export async function getReport(ctx: TenantContext, reportId: string) {
  const report = await withTenant(ctx, (db) =>
    db.report.findFirst({ where: { id: reportId }, select: REPORT_SELECT }),
  );

  if (!report) throw new NotFoundError('Report');
  return report;
}

/**
 * Ask for a report.
 *
 * Writes the row first and enqueues second, in that order and deliberately: a
 * job that arrived before its row existed would fail on a race, while a row
 * with no job is visibly QUEUED and can be retried. The failure that leaves
 * evidence is the better one.
 */
export async function createReport(
  ctx: TenantContext,
  input: CreateReportInput,
  correlationId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const now = clock.now();

  // The workspace is verified through the tenant-scoped client rather than
  // trusted from the body. A workspace in another organization is simply not
  // found, which is also what the composite foreign key would enforce a moment
  // later — this just produces a sentence instead of a constraint error.
  if (input.workspaceId) {
    const workspace = await withTenant(ctx, (db) =>
      db.workspace.findFirst({ where: { id: input.workspaceId, deletedAt: null } }),
    );
    if (!workspace) throw new NotFoundError('Workspace');
  }

  if (input.brandId) {
    const brand = await withTenant(ctx, (db) =>
      db.brand.findFirst({ where: { id: input.brandId, deletedAt: null } }),
    );
    if (!brand) throw new NotFoundError('Brand');
  }

  const report = await withTenant(ctx, async (db) => {
    const created = await db.report.create({
      data: {
        organizationId: ctx.organizationId,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        status: 'QUEUED',
        format: input.format,
        parameters: {
          from: input.from,
          to: input.to,
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          ...(input.brandId ? { brandId: input.brandId } : {}),
        },
        expiresAt: new Date(now.getTime() + REPORT_TTL_MS),
        // From the session, never from the body.
        ...(isUserPrincipal(ctx.principal) ? { requestedById: ctx.principal.userId } : {}),
      },
      select: REPORT_SELECT,
    });

    await audit(db, ctx, {
      action: 'report.requested',
      resourceType: 'Report',
      resourceId: created.id,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      after: { from: input.from, to: input.to, format: input.format },
      ...fingerprint,
    });

    return created;
  });

  await enqueue('reports', {
    organizationId: ctx.organizationId,
    correlationId,
    reportId: report.id,
  });

  return report;
}

/**
 * A signed URL for a finished report.
 *
 * Every refusal here is deliberate and each closes a different hole: a report
 * that is not READY has no object to sign; a lapsed one must not be reachable
 * even though its bytes may linger until a sweep removes them; and the key is
 * re-checked against this tenant's prefix before signing, which is the last
 * line of defence if anything above ever went wrong.
 */
export async function getReportDownloadUrl(
  ctx: TenantContext,
  reportId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const report = await withTenant(ctx, (db) =>
    db.report.findFirst({
      where: { id: reportId },
      // The one place `storageKey` is read, and it does not leave this function.
      select: { id: true, status: true, format: true, storageKey: true, expiresAt: true },
    }),
  );

  if (!report) throw new NotFoundError('Report');

  if (report.status !== 'READY' || !report.storageKey) {
    throw new ValidationError(`Report ${reportId} is ${report.status}`, {
      userMessage:
        report.status === 'FAILED'
          ? 'That report could not be generated. Ask for it again.'
          : 'That report is still being prepared.',
    });
  }

  if (report.expiresAt <= clock.now()) {
    throw new NotFoundError('Report', {
      userMessage: 'That report has expired. Generate a new one.',
    });
  }

  assertKeyBelongsTo(report.storageKey, ctx.organizationId);

  const { url, expiresAt } = await presignDownload({
    key: report.storageKey,
    contentType: 'text/csv',
    filename: `report-${report.id}.csv`,
    expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
  });

  // Audited because a report is client data leaving the system — "who
  // downloaded this and when" is a question an agency gets asked.
  await withTenant(ctx, (db) =>
    audit(db, ctx, {
      action: 'report.downloaded',
      resourceType: 'Report',
      resourceId: report.id,
      ...fingerprint,
    }),
  );

  return { url, expiresAt };
}
