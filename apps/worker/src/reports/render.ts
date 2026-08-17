import { clock, isAppError, type TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';
import { logger } from '@orbit/observability';
import { buildObjectKey, putObject } from '@orbit/storage';

/**
 * Rendering a client report (T3.5, SRS §19).
 *
 * Reads stored analytics; calls no provider. A report is a view of what has
 * already been captured, so generating one costs no Meta quota and cannot be
 * made slow — or expensive — by asking for it repeatedly.
 *
 * **CSV only, for now.** PDF is listed in the roadmap and is deliberately not
 * here: every route to it adds a heavy dependency (a headless browser, or a
 * layout engine) with real cost and real security surface, and that is a
 * decision to take deliberately rather than by picking a library mid-task. The
 * format enum has one member, so nothing pretends otherwise.
 *
 * **A missing metric stays missing.** The availability discipline of D-057
 * survives into the file: an unavailable metric is written as its reason, never
 * as an empty cell that a spreadsheet would total as zero.
 */

export interface RenderInput {
  ctx: TenantContext;
  reportId: string;
  correlationId: string;
}

export type RenderResult =
  | { kind: 'RENDERED'; sizeBytes: number; rows: number }
  | { kind: 'SKIPPED'; reason: 'ALREADY_SETTLED' };

export async function renderReport(input: RenderInput): Promise<RenderResult> {
  const { ctx, reportId } = input;

  const report = await withTenant(ctx, (db) =>
    db.report.findFirst({
      where: { id: reportId },
      select: { id: true, status: true, parameters: true, workspaceId: true },
    }),
  );

  // A retry after the render already finished must not overwrite a good file
  // with a second copy, and must not resurrect a report someone gave up on.
  if (!report || (report.status !== 'QUEUED' && report.status !== 'RENDERING')) {
    return { kind: 'SKIPPED', reason: 'ALREADY_SETTLED' };
  }

  await withTenant(ctx, (db) =>
    db.report.update({ where: { id: reportId }, data: { status: 'RENDERING' } }),
  );

  try {
    const params = readParameters(report.parameters);
    const rows = await collect(ctx, params);
    const csv = toCsv(rows);

    // The same key derivation media uses: the tenant is encoded in the path, so
    // isolation is auditable from the key alone and `assertKeyBelongsTo` has
    // something real to check on the way back out.
    const key = buildObjectKey({
      organizationId: ctx.organizationId,
      workspaceId: report.workspaceId ?? ctx.organizationId,
      assetId: report.id,
      extension: 'csv',
      variant: 'report',
      now: clock.now(),
    });

    const { sizeBytes } = await putObject({
      key,
      body: csv,
      contentType: 'text/csv; charset=utf-8',
      filename: `report-${report.id}.csv`,
    });

    await withTenant(ctx, (db) =>
      db.report.update({
        where: { id: reportId },
        data: { status: 'READY', storageKey: key, sizeBytes, failureCode: null },
      }),
    );

    return { kind: 'RENDERED', sizeBytes, rows: rows.length };
  } catch (error) {
    // A failed render is recorded on the row, not only thrown: the person who
    // asked is watching a status, and a report that silently stays QUEUED
    // forever is worse than one that says it failed.
    const code = isAppError(error) ? error.code : 'REPORT_RENDER_FAILED';
    const message = isAppError(error)
      ? error.userMessage
      : 'The report could not be generated. Try asking for it again.';

    await withTenant(ctx, (db) =>
      db.report.update({
        where: { id: reportId },
        data: { status: 'FAILED', failureCode: code, failureMessage: message },
      }),
    );

    logger.error('report render failed', {
      reportId,
      organizationId: ctx.organizationId,
      errorCode: code,
    });

    throw error;
  }
}

interface Parameters {
  from: Date;
  to: Date;
  workspaceId?: string | undefined;
  brandId?: string | undefined;
}

/**
 * Re-read the stored parameters rather than trusting them.
 *
 * They were validated when the report was requested, but a row written by an
 * older version of that code is exactly the input a renderer meets in
 * production. Unparseable values fall back to a sane window instead of
 * crash-looping a job that will never succeed.
 */
function readParameters(value: unknown): Parameters {
  const raw = (value ?? {}) as Record<string, unknown>;

  const to = asDate(raw['to']) ?? clock.now();
  const from = asDate(raw['from']) ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1_000);

  return {
    from,
    // Inclusive of the closing day: a report for "1st to 31st" that stopped at
    // midnight on the 31st would silently omit that day's posts.
    to: new Date(to.getTime() + 24 * 60 * 60 * 1_000 - 1),
    ...(typeof raw['workspaceId'] === 'string' ? { workspaceId: raw['workspaceId'] } : {}),
    ...(typeof raw['brandId'] === 'string' ? { brandId: raw['brandId'] } : {}),
  };
}

function asDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

interface Row {
  publishedAt: string;
  platform: string;
  account: string;
  post: string;
  permalink: string;
  metrics: Record<string, number>;
  availability: Record<string, string>;
}

async function collect(ctx: TenantContext, params: Parameters): Promise<Row[]> {
  const variants = await withTenant(ctx, (db) =>
    db.postVariant.findMany({
      where: {
        deletedAt: null,
        status: 'PUBLISHED',
        publishedAt: { gte: params.from, lte: params.to },
        post: {
          deletedAt: null,
          ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
          ...(params.brandId ? { brandId: params.brandId } : {}),
        },
      },
      select: {
        platform: true,
        publishedAt: true,
        externalPermalink: true,
        post: { select: { title: true, body: true } },
        socialAccount: { select: { displayName: true } },
        analytics: {
          select: { metrics: true, availability: true },
          orderBy: { capturedAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { publishedAt: 'asc' },
      // A cap rather than unbounded: a report is a document, and one that takes
      // a minute to render is one nobody waits for.
      take: 2_000,
    }),
  );

  return variants.map((variant) => ({
    publishedAt: variant.publishedAt?.toISOString().slice(0, 10) ?? '',
    platform: variant.platform,
    account: variant.socialAccount.displayName,
    post: variant.post.title ?? variant.post.body.slice(0, 120),
    permalink: variant.externalPermalink ?? '',
    metrics: (variant.analytics[0]?.metrics ?? {}) as Record<string, number>,
    availability: (variant.analytics[0]?.availability ?? {}) as Record<string, string>,
  }));
}

/**
 * The CSV.
 *
 * Columns are the union of every metric seen, because two platforms in one
 * report do not serve the same metrics and a fixed header would either drop
 * data or invent it.
 */
function toCsv(rows: readonly Row[]): string {
  const metricNames = [
    ...new Set(
      rows.flatMap((row) => [...Object.keys(row.metrics), ...Object.keys(row.availability)]),
    ),
  ].sort();

  const header = ['Published', 'Platform', 'Account', 'Post', 'Link', ...metricNames];

  const body = rows.map((row) => [
    row.publishedAt,
    row.platform,
    row.account,
    row.post,
    row.permalink,
    ...metricNames.map((name) => {
      const value = row.metrics[name];
      if (typeof value === 'number') return String(value);

      // Not blank: a spreadsheet reads an empty cell as zero and will happily
      // average it into a column. The reason is the honest content (D-057).
      const state = row.availability[name];
      return state === 'DEPRECATED'
        ? 'not provided by platform'
        : state === 'UNSUPPORTED'
          ? 'not offered for this account'
          : state === 'ERROR'
            ? 'could not be read'
            : 'not measured';
    }),
  ]);

  // A leading BOM so Excel opens UTF-8 correctly — without it, a client name
  // with an accent arrives mangled, which is the first thing anyone notices.
  return '﻿' + [header, ...body].map((line) => line.map(escapeCell).join(',')).join('\r\n');
}

/**
 * Quote a CSV cell.
 *
 * The leading-character guard is not about CSV at all: a cell beginning `=`,
 * `+`, `-` or `@` is executed as a formula when the file is opened in Excel or
 * Sheets, so a post body starting with one becomes code running on a client's
 * machine. Prefixing an apostrophe neutralises it while still displaying the
 * text.
 */
function escapeCell(value: string): string {
  const neutralised = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${neutralised.replace(/"/g, '""')}"`;
}
