import { afterEach, describe, expect, it } from 'vitest';
import {
  increment,
  observeDuration,
  recordProviderError,
  recordPublishOutcome,
  renderMetrics,
  resetMetrics,
  setGauge,
} from './metrics.js';

/**
 * The metrics surface (SRS §33, T1.19).
 *
 * Worth testing because the output is a wire format somebody else parses: a
 * malformed line makes a whole scrape fail, and it fails in Prometheus rather
 * than here, hours later, on the day the graph was needed.
 */

afterEach(() => {
  resetMetrics();
});

describe('counters and gauges', () => {
  it('renders help, type and value', () => {
    increment('orbit_test_total', 'A counter.', { queue: 'publish' });
    increment('orbit_test_total', 'A counter.', { queue: 'publish' });

    const output = renderMetrics();

    expect(output).toContain('# HELP orbit_test_total A counter.');
    expect(output).toContain('# TYPE orbit_test_total counter');
    expect(output).toContain('orbit_test_total{queue="publish"} 2');
  });

  it('keeps label sets apart', () => {
    increment('orbit_test_total', 'A counter.', { queue: 'publish' });
    increment('orbit_test_total', 'A counter.', { queue: 'media' });

    const output = renderMetrics();
    expect(output).toContain('orbit_test_total{queue="publish"} 1');
    expect(output).toContain('orbit_test_total{queue="media"} 1');
  });

  it('treats label order as irrelevant', () => {
    // Otherwise `{a,b}` and `{b,a}` would be two series describing one thing.
    increment('orbit_test_total', 'A counter.', { a: '1', b: '2' });
    increment('orbit_test_total', 'A counter.', { b: '2', a: '1' });

    expect(renderMetrics()).toContain('orbit_test_total{a="1",b="2"} 2');
  });

  it('renders an unlabelled series without empty braces', () => {
    setGauge('orbit_test_gauge', 'A gauge.', 7);
    expect(renderMetrics()).toContain('orbit_test_gauge 7');
    expect(renderMetrics()).not.toContain('orbit_test_gauge{}');
  });

  it('takes the latest value for a gauge', () => {
    setGauge('orbit_test_gauge', 'A gauge.', 1);
    setGauge('orbit_test_gauge', 'A gauge.', 9);
    expect(renderMetrics()).toContain('orbit_test_gauge 9');
  });

  it('escapes what Prometheus requires and nothing else', () => {
    increment('orbit_test_total', 'A counter.', { note: 'a "quoted" \\ value' });
    expect(renderMetrics()).toContain('note="a \\"quoted\\" \\\\ value"');
  });
});

describe('histograms', () => {
  it('renders cumulative buckets, a sum and a count', () => {
    observeDuration('orbit_test_seconds', 'A histogram.', 1.5, { platform: 'FACEBOOK' }, [1, 2, 5]);

    const output = renderMetrics();

    // 1.5 is over the 1s boundary and under 2s, so it lands in 2 and 5 but not 1.
    expect(output).not.toContain('le="1"');
    expect(output).toContain('orbit_test_seconds_bucket{le="2",platform="FACEBOOK"} 1');
    expect(output).toContain('orbit_test_seconds_bucket{le="5",platform="FACEBOOK"} 1');
    expect(output).toContain('orbit_test_seconds_bucket{le="+Inf",platform="FACEBOOK"} 1');
    expect(output).toContain('orbit_test_seconds_sum{platform="FACEBOOK"} 1.5');
    expect(output).toContain('orbit_test_seconds_count{platform="FACEBOOK"} 1');
  });

  it('accumulates across observations', () => {
    observeDuration('orbit_test_seconds', 'A histogram.', 0.5, {}, [1, 5]);
    observeDuration('orbit_test_seconds', 'A histogram.', 3, {}, [1, 5]);

    const output = renderMetrics();
    expect(output).toContain('orbit_test_seconds_bucket{le="1"} 1');
    expect(output).toContain('orbit_test_seconds_bucket{le="5"} 2');
    expect(output).toContain('orbit_test_seconds_count 2');
    expect(output).toContain('orbit_test_seconds_sum 3.5');
  });

  it('never leaks the internal aggregation marker', () => {
    observeDuration('orbit_test_seconds', 'A histogram.', 1, { platform: 'FACEBOOK' });
    expect(renderMetrics()).not.toContain('__agg');
  });
});

describe('the metrics this product cares about', () => {
  it('records publish outcomes so a success rate can be computed', () => {
    recordPublishOutcome({ platform: 'FACEBOOK', outcome: 'PUBLISHED', durationSeconds: 1.2 });
    recordPublishOutcome({ platform: 'FACEBOOK', outcome: 'PUBLISHED', durationSeconds: 0.8 });
    recordPublishOutcome({ platform: 'FACEBOOK', outcome: 'FAILED' });

    const output = renderMetrics();

    expect(output).toContain(
      'orbit_publish_outcomes_total{outcome="PUBLISHED",platform="FACEBOOK"} 2',
    );
    expect(output).toContain(
      'orbit_publish_outcomes_total{outcome="FAILED",platform="FACEBOOK"} 1',
    );
    // Latency only where there was one to record.
    expect(output).toContain('orbit_publish_duration_seconds_count{platform="FACEBOOK"} 2');
  });

  it('labels provider errors by normalised code, not by message', () => {
    // Low cardinality, and a rise in one code is a different incident from a
    // rise in another (SRS §37).
    recordProviderError('FACEBOOK', 'PROVIDER_AUTHENTICATION_ERROR');
    recordProviderError('FACEBOOK', 'PROVIDER_RATE_LIMIT');

    const output = renderMetrics();
    expect(output).toContain('code="PROVIDER_AUTHENTICATION_ERROR"');
    expect(output).toContain('code="PROVIDER_RATE_LIMIT"');
  });

  it('carries no tenant label anywhere', () => {
    // One customer's posting volume must not be readable by anyone who can
    // reach the metrics port, and per-tenant labels are unbounded cardinality.
    recordPublishOutcome({ platform: 'FACEBOOK', outcome: 'PUBLISHED' });
    recordProviderError('FACEBOOK', 'PROVIDER_UNAVAILABLE');

    const output = renderMetrics();
    expect(output).not.toContain('organizationId');
    expect(output).not.toContain('workspaceId');
  });

  it('renders nothing at all when nothing has happened', () => {
    expect(renderMetrics()).toBe('');
  });
});
