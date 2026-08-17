'use client';

import * as React from 'react';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * Asking for a report, and collecting it (T3.5, SRS §19).
 *
 * Rendering is asynchronous, so this polls. It polls *slowly* and it stops:
 * a report over a month of posts takes seconds, and a panel that hammers an
 * endpoint every 500ms for a job that failed is a self-inflicted load problem.
 *
 * The download is a two-step on purpose. The button asks the server for a
 * signed URL — checked against `report:export`, which is a different right from
 * generating — and only then opens it. The URL is good for five minutes; there
 * is no permanent link to a client's data anywhere in the page.
 */

export interface ReportRow {
  id: string;
  status: string;
  format: string;
  parameters: { from?: string; to?: string };
  sizeBytes: number | null;
  failureMessage: string | null;
  expiresAt: string;
  createdAt: string;
  requestedBy: { id: string; name: string | null; email: string } | null;
}

export interface ReportPanelProps {
  orgSlug: string;
  reports: ReportRow[];
  /** The window currently shown on the page, so a report matches what is on screen. */
  range: { from: string; to: string };
  workspaceId?: string | undefined;
  canGenerate: boolean;
  canExport: boolean;
}

const POLL_MS = 3_000;
const POLL_LIMIT = 20;

export function ReportPanel({
  orgSlug,
  reports: initial,
  range,
  workspaceId,
  canGenerate,
  canExport,
}: ReportPanelProps) {
  const [reports, setReports] = React.useState(initial);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const base = `/api/v1/orgs/${encodeURIComponent(orgSlug)}/reports`;
  const pending = reports.filter((r) => r.status === 'QUEUED' || r.status === 'RENDERING');

  // Poll only while something is actually rendering, and give up rather than
  // polling forever — a stuck job is a thing to report, not to wait on.
  React.useEffect(() => {
    if (pending.length === 0) return;

    let attempts = 0;
    let cancelled = false;

    const timer = setInterval(() => {
      attempts += 1;
      if (attempts > POLL_LIMIT) {
        clearInterval(timer);
        return;
      }

      void (async () => {
        try {
          const { reports: fresh } = await apiRequest<{ reports: ReportRow[] }>(base);
          if (!cancelled) setReports(fresh);
        } catch {
          // A failed poll is not worth an error message; the next one may work.
        }
      })();
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [base, pending.length]);

  async function generate() {
    setBusy('new');
    setError(null);

    try {
      const { report } = await apiRequest<{ report: ReportRow }>(base, {
        method: 'POST',
        body: JSON.stringify({
          from: range.from,
          to: range.to,
          ...(workspaceId ? { workspaceId } : {}),
          format: 'CSV',
        }),
      });

      setReports((current) => [report, ...current]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The report could not be requested.');
    } finally {
      setBusy(null);
    }
  }

  async function download(id: string) {
    setBusy(id);
    setError(null);

    try {
      const { url } = await apiRequest<{ url: string }>(`${base}/${id}/download`);
      window.location.assign(url);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That report could not be downloaded.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Reports</CardTitle>

        {canGenerate ? (
          <Button
            size="sm"
            loading={busy === 'new'}
            disabled={busy !== null}
            onClick={() => void generate()}
          >
            Generate for this range
          </Button>
        ) : null}
      </CardHeader>

      <CardBody className="space-y-3">
        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}

        {reports.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No reports yet. A report is a CSV of every published post in a range, with its figures.
          </p>
        ) : (
          <ul className="space-y-2">
            {reports.map((report) => (
              <li
                key={report.id}
                className="flex flex-wrap items-center gap-2 rounded border border-line px-3 py-2"
              >
                <span className="text-sm text-ink">
                  {report.parameters.from ?? '?'} → {report.parameters.to ?? '?'}
                </span>

                <Badge tone={toneFor(report.status)}>{labelFor(report.status)}</Badge>

                {report.sizeBytes ? (
                  <span className="text-xs text-ink-muted">{kb(report.sizeBytes)}</span>
                ) : null}

                {report.requestedBy ? (
                  <span className="text-xs text-ink-muted">
                    by {report.requestedBy.name ?? report.requestedBy.email}
                  </span>
                ) : null}

                {report.status === 'FAILED' && report.failureMessage ? (
                  <span className="w-full text-xs text-danger">{report.failureMessage}</span>
                ) : null}

                {report.status === 'READY' ? (
                  <span className="ml-auto flex items-center gap-2">
                    {/* Said plainly rather than left to be discovered: a link
                        that has quietly stopped working reads as a bug. */}
                    <span className="text-xs text-ink-muted">
                      available until {report.expiresAt.slice(0, 10)}
                    </span>
                    {canExport ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy !== null}
                        onClick={() => void download(report.id)}
                      >
                        Download
                      </Button>
                    ) : null}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function toneFor(status: string): 'neutral' | 'info' | 'success' | 'danger' {
  if (status === 'READY') return 'success';
  if (status === 'FAILED') return 'danger';
  return 'info';
}

function labelFor(status: string): string {
  switch (status) {
    case 'QUEUED':
      return 'Queued';
    case 'RENDERING':
      return 'Preparing';
    case 'READY':
      return 'Ready';
    default:
      return 'Failed';
  }
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}
