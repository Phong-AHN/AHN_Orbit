import { createServer, type Server } from 'node:http';
import { logger, renderMetrics as renderProcessMetrics } from '@orbit/observability';
import { queueDepths, deadLetterCount } from '@orbit/queue';
import { isShuttingDown } from '@orbit/queue';

/**
 * Health and metrics for the worker (T1.11 DoD: "queue depth and age exported
 * as metrics").
 *
 * The worker has no HTTP surface of its own, but a container needs a liveness
 * probe and an operator needs to see whether work is moving. Two endpoints:
 *
 *   • `/health` — is this process alive and not shutting down. During shutdown
 *     it reports 503 deliberately, so the orchestrator stops routing to it and
 *     draining is not mistaken for a crash.
 *   • `/metrics` — Prometheus text format. **Queue age matters more than
 *     depth**: 500 fast jobs is healthy, 3 stuck ones is not, so
 *     `orbit_queue_oldest_waiting_seconds` is the one to alarm on.
 *
 * Nothing tenant-scoped is exposed. Depths are per queue, never per
 * organization — that would leak one customer's volume to anyone who can reach
 * the metrics port.
 */

export function startHealthServer(port: number): Server {
  const server = createServer((request, response) => {
    const url = request.url ?? '/';

    if (url === '/health' || url === '/healthz') {
      const draining = isShuttingDown();
      response.writeHead(draining ? 503 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: draining ? 'draining' : 'ok' }));
      return;
    }

    if (url === '/metrics') {
      void renderMetrics()
        .then((body) => {
          response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
          response.end(body);
        })
        .catch((error: unknown) => {
          logger.error('failed to render metrics', { error: String(error) });
          response.writeHead(500);
          response.end('# metrics unavailable\n');
        });
      return;
    }

    response.writeHead(404);
    response.end();
  });

  server.listen(port, () => {
    logger.info('worker health server listening', { port });
  });

  return server;
}

async function renderMetrics(): Promise<string> {
  const [depths, dlq] = await Promise.all([queueDepths(), deadLetterCount()]);

  const lines: string[] = [
    '# HELP orbit_queue_jobs Jobs per queue by state.',
    '# TYPE orbit_queue_jobs gauge',
  ];

  for (const depth of depths) {
    for (const state of ['waiting', 'active', 'delayed', 'failed'] as const) {
      lines.push(`orbit_queue_jobs{queue="${depth.queue}",state="${state}"} ${depth[state]}`);
    }
  }

  lines.push(
    '# HELP orbit_queue_oldest_waiting_seconds Age of the oldest waiting job. Alarm on this, not on depth.',
    '# TYPE orbit_queue_oldest_waiting_seconds gauge',
  );
  for (const depth of depths) {
    lines.push(
      `orbit_queue_oldest_waiting_seconds{queue="${depth.queue}"} ${(depth.oldestWaitingMs / 1000).toFixed(1)}`,
    );
  }

  lines.push(
    '# HELP orbit_dead_letter_entries Jobs that will not be retried without a human.',
    '# TYPE orbit_dead_letter_entries gauge',
    `orbit_dead_letter_entries ${dlq}`,
  );

  // Gauges read from Redis above; counters accumulated in-process below —
  // publish outcomes, publish latency, provider errors by code, job outcomes
  // (T1.19). Together they answer the three questions the DoD asks: is work
  // moving, are publishes succeeding, and what is failing.
  return `${lines.join('\n')}\n${renderProcessMetrics()}`;
}
