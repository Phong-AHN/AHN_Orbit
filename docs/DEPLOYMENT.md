# AHN Orbit — Deployment

> Two deployables, one database, one Redis. Last updated: 2026-08-12 (T1.19). Answers SRS §45, §51.

---

## 1. Topology

```
Vercel                          AWS ECS Fargate
┌──────────────────┐            ┌──────────────────────┐
│ apps/web         │            │ apps/worker          │
│ Next.js 15       │  enqueues  │ BullMQ consumers     │
│ produces jobs ───┼───────────▶│ the only consumer    │
└────────┬─────────┘            └──────────┬───────────┘
         │                                  │
         └────────► Postgres 17 ◄───────────┘
         └────────► Redis 7    ◄───────────┘
                    S3
```

### Put the compute next to the database

Not a tuning detail — it is the difference between a fast app and an unusable
one, and it is invisible in code review because nothing about the code changes.

A serverless function opens a *new* database connection on a cold invocation:
TCP, then TLS, then the Postgres startup and SCRAM auth. That is six or seven
round trips before the first row is read. At 5 ms of latency nobody notices. At
230 ms — which is what a US-East function pays to reach Singapore — the same
handshake costs a second and a half, and a page that runs four queries feels
broken.

Measured on this deployment, from inside the function, with the region left at
Vercel's default (`iad1`, US East) and the database in `ap-southeast-1`:

| Check | Latency |
| --- | --- |
| `SELECT 1` (Postgres, Singapore) | **1141 / 2901 / 3806 ms** |
| `PING` (Redis, same region) | 3–46 ms |
| `HeadBucket` (S3, Sydney) | 214–673 ms |

`vercel.json` pins functions to `sin1` for that reason. **The rule: every
dependency on the request path belongs in the same region as the function.**
Move one and the others must follow — including Redis, which is co-located with
the function today and would become the slow one after this change.

> If the Vercel project's **Root Directory** is `apps/web`, `vercel.json` must
> live there instead of at the repo root, or it is ignored silently. The same
> setting exists in the dashboard under Settings → Functions → Function Region.

The split is not a preference (**D-002**). A BullMQ worker is a long-lived process holding a
blocking Redis connection; Vercel functions are request-scoped and cap at 800s. It is not
expressible as a function.

**Redis must be reachable over public TLS from both** (**D-003**), which is why it is Upstash rather
than ElastiCache — the latter is VPC-private and unreachable from Vercel functions without
Enterprise Secure Compute.

---

## 2. Environment

Required everywhere:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Pooled. `DIRECT_URL` for migrations if using PgBouncer |
| `REDIS_URL` | TLS. BullMQ needs `maxRetriesPerRequest: null` — already set |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Bucket blocks all public access |
| `CREDENTIAL_ENCRYPTION_KEY` | base64, 32 bytes. **Losing this loses every connection** |
| `STATE_SIGNING_SECRET` | base64, 32 bytes. OAuth CSRF |

Worker only: `ORBIT_ROLE=worker` — `assertWorkerProcess()` refuses to consume without it, which is
what catches the deployment mistake of running the wrong bundle (**D-022**).

Optional: `FACEBOOK_APP_ID`/`FACEBOOK_APP_SECRET` (absent ⇒ the mock provider, which the registry
refuses in production), `SENTRY_DSN`, `WORKER_HEALTH_PORT` (3100), `S3_ENDPOINT` for MinIO.

**`loadRootEnv()` deliberately does not read `.env` in production.** Configuration comes from the
platform. `SKIP_ENV_VALIDATION=true` is the designed seam for `next build`, which sets
`NODE_ENV=production` before any real variable exists.

---

## 3. Order of operations

**Migrations → worker → web.** In that order, and it matters:

1. `pnpm db:migrate:deploy` — additive migrations only; the app must tolerate both schemas briefly.
2. **Worker.** It drains on SIGTERM and reports `outcome: DRAINED`. **Do not set the grace period
   below 90s** — a publish may be mid-call with a 60s timeout, and killing it produces a variant
   stuck in `PUBLISHING` whose outcome nobody knows (`RUNBOOK.md` §3.3).
3. **Web.** Vercel handles this.

Rolling back the web app is safe. Rolling back the worker is safe. **Rolling back a migration is
not** — write migrations so the previous version of the app still works against them.

---

## 4. Health and probes

| Endpoint | Use |
|---|---|
| `GET /api/health` (web) | Liveness |
| `GET /api/health/deep` (web) | Database, Redis, storage. Reports config by **presence only** |
| `GET :3100/health` (worker) | Liveness. **503 while draining** — deliberate, so the orchestrator stops routing during a drain rather than treating it as a crash |
| `GET :3100/metrics` (worker) | Prometheus. Scrape every 15–30s |

Do not expose the worker's port publicly. It carries no tenant data, but queue depth is still
operational information about the business.

---

## 5. Scaling

**Web** scales with traffic; it holds no queue state.

**Worker** scales horizontally and safely: the deterministic job id, the atomic Postgres claim and
the per-account Redis lock mean several replicas cannot double-publish (`SECURITY.md` §7). Per-queue
concurrency lives in `packages/queue/src/queues.ts`; `publish` is 8.

The scheduler sweep is safe to run on every replica — the `PublishingJob` unique constraint makes a
concurrent sweep a no-op rather than a twin, and BullMQ drops the duplicate add. Proven by a test
running three sweeps at once.

**The bottleneck to watch is not CPU.** It is `orbit_queue_oldest_waiting_seconds`.

---

## 6. Backups and recovery

- **Postgres is the source of truth.** Point-in-time recovery. The schedule, the content, the audit
  trail and the publishing ledger all live here.
- **Redis is not.** Losing it loses in-flight jobs and rate-limit buckets; the sweep re-derives what
  is due from Postgres (**D-009**). Do not restore Redis from a snapshot into a running system —
  replaying old jobs is how a stale publish escapes.
- **S3** with versioning and lifecycle rules. Soft-deleted assets are purged after 30 days.
- **`CREDENTIAL_ENCRYPTION_KEY` is not recoverable from a database backup.** Store it where the
  database backup is not.

---

## 7. Going live with real publishing

Everything below the provider is production-ready and tested; the provider is not yet real.

1. **Meta App Review + Business Verification.** `pages_manage_posts`, `pages_read_engagement`,
   `pages_show_list` are all gated behind it. Realistically **2–4 weeks including one revision
   round** — see `SOCIAL_PROVIDERS.md` §2. **This has not started, and it is the launch blocker.**
2. Set `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET` in production. The registry then picks the real
   adapter and **refuses the mock** in production.
3. Run the §32 flow once, manually, against a real Meta Test Page:
   ```bash
   ORBIT_E2E_REAL_PROVIDER=true pnpm test:e2e
   ```
   That flag exists for exactly this (**D-047**). Without it, tests never touch a real platform even
   when Meta credentials are configured — which is what stops a developer's `.env` from publishing
   to Facebook during a test run.
4. Watch `orbit_provider_errors_total` for the first day. Real rate-limit headers and real error
   shapes are the two things `MockProvider` cannot rehearse.

---

## 8. What is not wired yet

- **Sentry.** `SENTRY_DSN` is in the schema and `reportError` is the seam; no SDK is installed
  (**D-048**). Wiring it is a dependency plus one `setErrorReporter` call per deployable.
- **Email.** Same shape (**D-034**): rows are written, nothing sends.
- **CI.** The commands are in §9; no pipeline file ships in this repo.

---

## 9. The commands CI should run

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test                                   # no infrastructure needed
docker compose up -d                        # Postgres, Redis, MinIO
pnpm db:migrate:deploy
pnpm test:integration
pnpm test:e2e                               # the §32 flow
SKIP_ENV_VALIDATION=true pnpm build
```

`pnpm verify:full` runs everything except the build.
