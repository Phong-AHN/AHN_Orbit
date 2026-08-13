/**
 * Operational metrics (SRS §33, docs/ARCHITECTURE.md §9, T1.19).
 *
 * An in-process registry rendering Prometheus text, deliberately not a metrics
 * SDK. The reasons are the same ones that kept a timezone library out of
 * `@orbit/core`: what we need is a counter, a gauge and a coarse histogram, the
 * whole thing is about eighty lines, and a dependency here would have to be
 * carried by both deployables.
 *
 * ## What this is for
 *
 * Three questions, from the DoD: **is work moving** (queue depth and age, which
 * `apps/worker/src/health.ts` already answers), **are publishes succeeding**,
 * and **what is failing**. The first is a gauge read from Redis on demand; the
 * other two are counters accumulated as things happen, which is why they need
 * somewhere to live.
 *
 * ## What it is not
 *
 * Not per tenant. A metric labelled by `organizationId` would put one
 * customer's posting volume on a metrics endpoint that anyone who can reach the
 * port can read, and would make the cardinality unbounded besides. Labels here
 * are platform, queue, outcome and error code — all low-cardinality and none of
 * them anybody's business but ours.
 *
 * ## Process-local, and honest about it
 *
 * Counters reset when a process restarts and are not shared between the web app
 * and the worker or between worker replicas. That is normal for Prometheus —
 * `rate()` over a counter handles resets, and each replica is scraped
 * separately — but it does mean these numbers are not a ledger. The ledger is
 * `PublishingAttempt` in Postgres, which is durable and per tenant. These are
 * for alarms.
 */

export type MetricLabels = Readonly<Record<string, string>>;

interface Series {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  values: Map<string, number>;
}

const registry = new Map<string, Series>();

/**
 * Buckets for publish latency, in seconds.
 *
 * Chosen from what the numbers mean rather than from a round-number habit: a
 * publish under two seconds is healthy, ten is slow, thirty is a provider in
 * trouble, and sixty is the engine's own timeout — so the top bucket boundary
 * is the point at which the publish was abandoned rather than merely slow.
 */
export const PUBLISH_LATENCY_BUCKETS = [0.5, 1, 2, 5, 10, 30, 60] as const;

function keyFor(labels: MetricLabels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  return entries.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(',');
}

/** Prometheus label values escape backslash, quote and newline. Nothing else. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function series(name: string, help: string, type: Series['type']): Series {
  const existing = registry.get(name);
  if (existing) return existing;

  const created: Series = { name, help, type, values: new Map() };
  registry.set(name, created);
  return created;
}

export function increment(name: string, help: string, labels: MetricLabels = {}, by = 1): void {
  const metric = series(name, help, 'counter');
  const key = keyFor(labels);
  metric.values.set(key, (metric.values.get(key) ?? 0) + by);
}

export function setGauge(
  name: string,
  help: string,
  value: number,
  labels: MetricLabels = {},
): void {
  const metric = series(name, help, 'gauge');
  metric.values.set(keyFor(labels), value);
}

/**
 * Record a duration into a cumulative histogram.
 *
 * Stored as Prometheus expects it: `_bucket` counts are cumulative (`le`),
 * plus `_sum` and `_count`, so `histogram_quantile` and average latency both
 * work without post-processing.
 */
export function observeDuration(
  name: string,
  help: string,
  seconds: number,
  labels: MetricLabels = {},
  buckets: readonly number[] = PUBLISH_LATENCY_BUCKETS,
): void {
  const metric = series(name, help, 'histogram');

  for (const bucket of buckets) {
    if (seconds <= bucket) {
      const key = keyFor({ ...labels, le: String(bucket) });
      metric.values.set(key, (metric.values.get(key) ?? 0) + 1);
    }
  }

  const infKey = keyFor({ ...labels, le: '+Inf' });
  metric.values.set(infKey, (metric.values.get(infKey) ?? 0) + 1);

  const sumKey = keyFor({ ...labels, __agg: 'sum' });
  metric.values.set(sumKey, (metric.values.get(sumKey) ?? 0) + seconds);

  const countKey = keyFor({ ...labels, __agg: 'count' });
  metric.values.set(countKey, (metric.values.get(countKey) ?? 0) + 1);
}

/** Render everything recorded so far as Prometheus text (version 0.0.4). */
export function renderMetrics(): string {
  const lines: string[] = [];

  for (const metric of registry.values()) {
    lines.push(`# HELP ${metric.name} ${metric.help}`);
    lines.push(`# TYPE ${metric.name} ${metric.type}`);

    for (const [key, value] of metric.values) {
      if (metric.type === 'histogram') {
        lines.push(renderHistogramLine(metric.name, key, value));
      } else {
        lines.push(key.length > 0 ? `${metric.name}{${key}} ${value}` : `${metric.name} ${value}`);
      }
    }
  }

  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * A histogram row is one of three shapes, distinguished by the pseudo-label the
 * recorder attached. `__agg` never reaches the output — it is a marker, not a
 * dimension.
 */
function renderHistogramLine(name: string, key: string, value: number): string {
  if (key.includes('__agg="sum"')) {
    return `${name}_sum${withoutAgg(key)} ${value}`;
  }
  if (key.includes('__agg="count"')) {
    return `${name}_count${withoutAgg(key)} ${value}`;
  }
  return `${name}_bucket{${key}} ${value}`;
}

function withoutAgg(key: string): string {
  const remaining = key
    .split(',')
    .filter((part) => !part.startsWith('__agg='))
    .join(',');

  return remaining.length > 0 ? `{${remaining}}` : '';
}

/** Drop everything. Tests only — a process never needs this. */
export function resetMetrics(): void {
  registry.clear();
}

// ── The metrics this product actually cares about ───────────────────────────

/**
 * One publish outcome.
 *
 * `outcome` is the engine's own vocabulary, so the metric and the publishing
 * log agree: PUBLISHED, FAILED, PARKED, DEFERRED, NOT_CLAIMABLE. Success rate
 * is then `PUBLISHED / (PUBLISHED + FAILED + PARKED)` — deferrals are not
 * failures, they are work still in progress, and counting them as either would
 * make the graph lie in one direction or the other.
 */
export function recordPublishOutcome(input: {
  platform: string;
  outcome: string;
  durationSeconds?: number | undefined;
}): void {
  increment(
    'orbit_publish_outcomes_total',
    'Publish attempts by final outcome. Success rate is PUBLISHED over PUBLISHED+FAILED+PARKED.',
    { platform: input.platform, outcome: input.outcome },
  );

  if (input.durationSeconds !== undefined) {
    observeDuration(
      'orbit_publish_duration_seconds',
      'Time from claim to settled outcome, per publish.',
      input.durationSeconds,
      { platform: input.platform },
    );
  }
}

/**
 * One normalised provider error.
 *
 * Labelled by the taxonomy code rather than the provider's own message, which
 * is both low-cardinality and the thing worth alarming on: a rise in
 * `PROVIDER_AUTHENTICATION_ERROR` is a different incident from a rise in
 * `PROVIDER_RATE_LIMIT`.
 */
export function recordProviderError(platform: string, code: string): void {
  increment(
    'orbit_provider_errors_total',
    'Provider failures by normalised error code (SRS §37).',
    { platform, code },
  );
}

/** One job outcome, for queue-level error rate independent of publishing. */
export function recordJobOutcome(queue: string, outcome: string): void {
  increment('orbit_jobs_total', 'Job attempts by queue and outcome.', { queue, outcome });
}
