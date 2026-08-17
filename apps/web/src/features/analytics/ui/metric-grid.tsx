import { Badge, Card, CardBody } from '@orbit/ui';
import { compactNumber, metricLabel, orderMetrics, unavailableReason } from './metric-label';

/**
 * A row of numbers, and — just as prominently — the numbers that are not there.
 *
 * The unavailable ones are rendered *in the same grid*, not tucked into a
 * footnote. That is the point of SRS §18: an agency showing this to a client
 * needs "Facebook stopped reporting this" to be as visible as the figures
 * beside it, because the alternative is being asked why engagement fell to zero
 * in a month when it did not.
 */

export interface MetricGridProps {
  metrics: Record<string, number>;
  availability: Record<string, string>;
  /** Shown under the grid; the version a number came from is part of the number. */
  apiVersion?: string | null;
}

export function MetricGrid({ metrics, availability, apiVersion }: MetricGridProps) {
  const available = Object.entries(metrics).sort(([a], [b]) => a.localeCompare(b));

  const missing = Object.entries(availability)
    .filter(([name, state]) => state !== 'AVAILABLE' && metrics[name] === undefined)
    .sort(([a], [b]) => a.localeCompare(b));

  if (available.length === 0 && missing.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        Nothing measured yet. Figures arrive within a few hours of publishing.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {available.map(([name, value]) => (
          <div key={name} className="rounded border border-line px-3 py-2">
            <dt className="truncate text-xs text-ink-muted">{metricLabel(name)}</dt>
            <dd className="mt-0.5 text-xl font-semibold tabular-nums text-ink">
              {compactNumber(value)}
            </dd>
          </div>
        ))}

        {missing.map(([name, state]) => (
          <div key={name} className="rounded border border-dashed border-line px-3 py-2">
            <dt className="truncate text-xs text-ink-muted">{metricLabel(name)}</dt>
            {/* An em dash, never a nought. A zero here is a claim about the
                world; this is a statement about the data. */}
            <dd className="mt-0.5 text-xl font-semibold text-ink-muted">—</dd>
            <p className="mt-0.5 text-[11px] leading-tight text-ink-muted">
              {unavailableReason(state)}
            </p>
          </div>
        ))}
      </dl>

      {apiVersion ? (
        <p className="text-xs text-ink-muted">
          Read from Graph API {apiVersion}.{' '}
          <span className="text-ink-muted">
            Metric definitions change between versions, so figures may not match older reports.
          </span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The same idea at one-line size, for a post row in a list.
 *
 * The four shown are **chosen per platform** rather than taken in whatever
 * order the provider's JSON arrived (**D-074**) — which metric a client sees
 * first should not be an accident of iteration order.
 */
export function MetricStrip({
  metrics,
  platform,
}: {
  metrics: Record<string, number>;
  platform: string;
}) {
  const entries = orderMetrics(platform, metrics).slice(0, 4);

  if (entries.length === 0) {
    return <Badge tone="neutral">Not measured yet</Badge>;
  }

  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {entries.map(([name, value]) => (
        <span key={name} className="text-xs text-ink-secondary">
          <span className="font-medium tabular-nums text-ink">{compactNumber(value)}</span>{' '}
          {metricLabel(name).toLowerCase()}
        </span>
      ))}
    </div>
  );
}

/** Totals across a window, with the same refusal to invent a number. */
export function OverviewTotals({
  totals,
  unavailable,
}: {
  totals: Record<string, number>;
  unavailable: Record<string, string>;
}) {
  return (
    <Card>
      <CardBody>
        <MetricGrid metrics={totals} availability={unavailable} />

        {Object.keys(unavailable).length > 0 ? (
          <p className="mt-3 text-xs text-ink-muted">
            A metric shown as — could not be totalled across every post in this range, so no total
            is given. A partial sum presented as a total is the one number worth refusing.
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
