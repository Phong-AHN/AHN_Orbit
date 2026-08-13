# Worker service — deployment notes

Companion to `worker-task-definition.json`. Records the decisions behind the numbers,
because most of them are wrong to change without knowing why they are what they are.

## Autoscaling

The worker scales on **queue age**, not queue depth and not CPU.

Depth is a poor signal: 500 fast notification jobs is a healthy queue, and three stuck
publishes is not. CPU is worse — these jobs are almost entirely waiting on Postgres,
S3 and the Graph API, so a badly backed-up worker looks idle.

| Setting | Value | Why |
|---|---|---|
| Metric | `orbit_queue_oldest_waiting_seconds` (custom, from `/metrics`) | Measures whether work is *moving* |
| Target | 60s | Publishing tolerance is ±60s (**C10**); a backlog older than that risks missing slots |
| Min tasks | 2 | One task means a deploy or a crash stops all background work |
| Max tasks | 10 | Above this, per-account provider rate limits bind before throughput does |
| Scale-out cooldown | 60s | Faster than a job's own backoff, so it reacts within one retry cycle |
| Scale-in cooldown | 300s | Slow, because scaling in mid-publish costs a drain each time |

Min 2 is also what makes a rolling deploy safe: BullMQ redistributes to the surviving
task while the other drains.

## Shutdown timing

Three numbers that must stay ordered:

```
worker grace (25s)  <  ECS stopTimeout (40s)  <  deregistration delay
```

The worker stops taking jobs on SIGTERM and lets in-flight ones finish (`shutdown.ts`).
If `stopTimeout` were the smaller number, ECS would SIGKILL mid-publish — precisely the
ambiguous outcome the idempotency design exists to prevent. The 15s margin covers the
final Redis and Postgres writes.

A job still running at the grace deadline is not lost: BullMQ's `lockDuration` (120s)
expires and another worker reclaims it, and layer 2's atomic claim on `PostVariant`
means a reclaimed publish that already went out finds the row no longer `SCHEDULED`
and exits without re-posting.

## Placement

Two availability zones minimum. The worker holds long-lived Redis connections, so an AZ
failure should cost one task's in-flight work, not all of it.

`readonlyRootFilesystem: true` — the worker writes nothing to disk. Media streams from
S3 through memory. If that ever changes, use a `tmpfs` mount rather than turning this
off.

## What is deliberately absent

- **No public ingress.** Port 3100 is reachable from the VPC only; `/metrics` exposes
  per-queue volumes, which are commercially sensitive even though they are not
  tenant-scoped.
- **No `awslogs` blocking mode.** A CloudWatch hiccup must not stall a publish.
- **No secrets in `environment`.** Anyone with `ecs:DescribeTaskDefinition` can read
  that block; `secrets` resolves from Secrets Manager at start.

## Runbook: a queue is backing up

1. `/metrics` → which queue, and is `oldest_waiting_seconds` climbing or flat?
2. Climbing with `active > 0` → jobs are slow. Check provider latency and the rate
   limit buckets before scaling; scaling into a provider rate limit makes it worse.
3. Climbing with `active = 0` → workers are not consuming. Check Redis connectivity and
   whether tasks are stuck draining.
4. Flat and high with a rising `orbit_dead_letter_entries` → a poison job type. The
   dead-letter entries carry the full cause chain; fix the cause before re-enqueueing.
