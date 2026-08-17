# AHN Orbit — Operational Runbook

> What to do when something is wrong. Written for whoever is on call, including the version of
> yourself who has not looked at this system for three months.
> Last updated: 2026-08-12 (T1.19).
>
> **The one rule that overrides everything here: if you cannot tell whether a post went out, do not
> make it go out again.** The whole publishing design is organised around that (**D-027**), and an
> operator in a hurry is the most likely person to break it.

---

## 1. Where to look first

| Question | Where |
|---|---|
| Is the platform up? | `GET /api/health/deep` — database, Redis, storage |
| Is work moving? | Worker `/metrics` → `orbit_queue_oldest_waiting_seconds` |
| Is anything stuck? | `/admin` → dead letters |
| Is a customer affected? | Their org's `/orgs/{slug}/dashboard` → alerts |
| What happened to one post? | `/orgs/{slug}/publishing` → the job's attempt chain |
| Why did *this request* fail? | Search logs for the `correlationId` from the error envelope |

**Every error response carries a `correlationId`**, and every log line for that request carries it
too — browser → API → queue → worker → provider. Ask the reporter for it before anything else.

---

## 2. Alarms worth having

Depth alone is a poor alarm: 500 fast jobs is healthy and three stuck ones are not.

| Alarm | Expression | Why |
|---|---|---|
| Publishing is late | `orbit_queue_oldest_waiting_seconds{queue="publish"} > 300` | Assumption C10 is ±60s; five minutes means something is wrong |
| Scheduler has stopped | `orbit_queue_oldest_waiting_seconds{queue="scheduler"} > 120` | The sweep runs every 30s; if it is not, nothing publishes |
| Publish success rate | `rate(orbit_publish_outcomes_total{outcome="PUBLISHED"}[15m]) / rate(orbit_publish_outcomes_total{outcome=~"PUBLISHED\|FAILED\|PARKED"}[15m]) < 0.95` | Deferrals are excluded: they are work in progress, not failures |
| Anything parked | `increase(orbit_publish_outcomes_total{outcome="PARKED"}[1h]) > 0` | **Page on this.** Nothing automated will touch a parked publish again |
| Tokens dying | `increase(orbit_provider_errors_total{code="PROVIDER_AUTHENTICATION_ERROR"}[1h]) > 3` | Several at once usually means an app-level problem, not one customer |
| Dead letters | `orbit_dead_letter_entries > 0` | Not urgent by itself; look within a day |

**Metrics are per process and reset on restart.** That is normal for Prometheus counters — `rate()`
handles resets — but it means these are alarms, not a ledger. The ledger is `PublishingAttempt` in
Postgres.

---

## 3. Incidents

### 3.1 "A post did not go out"

1. Open `/orgs/{slug}/publishing`. Find the post.
2. Read the **variant status**, which is the answer:

| Status | What it means | Do |
|---|---|---|
| `SCHEDULED`, time passed | The sweep did not pick it up | §3.2 |
| `PUBLISHING`, stuck | A worker died mid-publish | §3.3 — **do not touch the claim** |
| `FAILED` | The provider refused it | Read the error; `presentFailure` names the fix |
| `NEEDS_REVIEW` | **We do not know if it published** | §3.4 |
| `PUBLISHED` | It went out | Check the permalink before saying otherwise |

### 3.2 Scheduled, but nothing happened

Usually one of three things, in order of likelihood:

1. **The account needs reconnecting.** The sweep deliberately skips variants whose account is not
   `ACTIVE` (**D-032**) — they stay `SCHEDULED` with their times intact. Check the org's dashboard;
   the alert will say so. Fix: the agency reconnects, and the next sweep picks it up. Nothing to
   reschedule.
2. **The worker is not running.** Check `/health` on the worker and `orbit_queue_oldest_waiting_seconds`.
3. **The post is not `SCHEDULED` as a whole.** A variant left behind on a post that was pulled back
   is skipped on purpose.

### 3.3 A variant stuck in `PUBLISHING`

A worker was killed mid-publish. **Do not clear the claim by hand, and do not requeue it.** The
outcome is unknown, which is exactly the case where guessing double-posts.

The `reconcile-stuck-jobs` maintenance task (every 5 minutes) finds these and reports them. The next
worker to take the claim reconciles before doing anything (layer 4). If reconciliation is
inconclusive it parks in `NEEDS_REVIEW` — go to §3.4.

### 3.4 A parked publish (`NEEDS_REVIEW`)

**This is the one that needs a person, and it is a person at the agency rather than us.**

The system could not establish whether the post exists. Nothing automated will touch it again.

The agency resolves it from the post's page, with three answers, all requiring a reason and all
audited (**D-029**):

- **"It published"** → requires the external post id. Someone has to look at the Page and copy it.
- **"It did not publish"** → returns it to the engine at a new instant, with a new idempotency key.
  No publishing happens in the resolution itself.
- **"Leave it"** → `FAILED`.

**We cannot do this for them**, and should not want to: the answer requires looking at the client's
Page, which we have no access to.

### 3.5 An account needs reconnecting

`PROVIDER_AUTHENTICATION_ERROR` marks the account `NEEDS_RECONNECT` automatically, notifies whoever
can fix it, and the scheduler stops queueing its posts. A Page token dies without expiring — a
password change or a permission revocation is enough (`SOCIAL_PROVIDERS.md` §4).

The agency reconnects at `/orgs/{slug}/settings/accounts`. It is the same OAuth flow as connecting;
scheduled posts resume on the next sweep.

**Several at once** across different organizations usually means something at the app level — a
permission lapsed, App Review status changed, or the app secret rotated. Check one account's
`healthError` before telling six agencies to reconnect.

### 3.6 Dead letters

`/admin/jobs`. Each entry has the whole cause chain, already reduced to safe codes and messages.

- **Re-enqueue** for `media`, `analytics`, `notifications`, `account-health`, `maintenance`,
  `scheduler`. Requires a reason, and writes into the customer's own audit log with your name.
- **`publish` cannot be re-enqueued from here** (**D-045**). It is browsable and discardable only.
  The agency retries from their own publishing log, so it goes through the same checks and the same
  four idempotency layers. Tell them; do not look for a way around it.

### 3.7 Redis is gone

Scheduling and publishing stop; the web app keeps serving. Nothing is lost: the schedule lives in
Postgres, and the sweep re-derives what is due (**D-009**). When Redis returns, the sweep catches up
and the `PublishingJob` unique constraint means a duplicate sweep is a no-op rather than a twin.

Watch for posts that passed `STALE_SCHEDULE_MS` (2h) during the outage — those are surfaced as
overdue rather than published late, deliberately: publishing a "good morning" at 4pm is worse than
not publishing it.

### 3.8 The database is gone

Everything stops. Workers fail their jobs and retry with backoff; the claim is in Postgres, so
nothing can publish while it is down — which is the safe failure direction.

---

## 4. Routine operations

### Deploying

See `DEPLOYMENT.md`. In short: migrations first, then the worker, then the web app. The worker
drains on SIGTERM (`outcome: DRAINED` in the log) — do not shorten the grace period below the
publish timeout of 60s, or a publish can be killed mid-call and become a §3.3.

### Retention — what the nightly sweep deletes, and how to check it

Runs at **03:20 UTC** on the `maintenance` queue. It removes:

- `PostAnalytics` and `AnalyticsSnapshot` older than **13 months**;
- `Report` rows past `expiresAt`, **and** their S3 objects.

It never touches posts, variants, publishing jobs or attempts, or the audit log.

To see what it did, ask the tenant's own trail rather than the logs — the sweep
writes one row per organization, only when something was removed:

```sql
SELECT "organizationId", "after", "createdAt"
FROM "AuditLog"
WHERE action = 'retention.swept'
ORDER BY "createdAt" DESC
LIMIT 20;
```

`after` carries the counts and the cutoff that was applied.

**If storage is unreachable**, expired report rows are left in place on purpose
— the row is the only record that the object may still exist (**D-064**). Look
for `could not remove a report object` in the worker log; the next night's run
clears them once S3 is reachable. Nothing needs doing by hand.

**To stop it entirely** — during an incident, or before a migration you are
unsure of — remove the repeatable job. It is one entry and re-registers on the
next worker boot:

```
bull:maintenance:repeat:cron:retention
```

Nothing depends on it having run. Skipping a night costs a night of storage.

### Rotating the credential encryption key

`CREDENTIAL_ENCRYPTION_KEY_VERSION` exists so keys rotate without a migration. Add the new key,
bump the version for new writes, re-seal existing rows in a batch, then retire the old key. The AAD
binds each credential to `{ organizationId, socialAccountId }`, so a re-seal must preserve both.

### Adding a platform administrator

`isPlatformAdmin` is set by a deliberate database change and nothing else — never from a token
claim, never through the UI. That is intentional (docs/RBAC.md §1 rule 2).

---

## 5. What you cannot do, and why

| Not possible | Why |
|---|---|
| Read a customer's posts from `/admin` | The admin surface has no tenant context; the scoped client cannot be constructed (**D-043**) |
| See a decrypted credential | No role holds `social_credential:read_plaintext`, including you |
| See which Pages a client manages | Status only (**D-044**) — ask the agency |
| Re-enqueue a publish | **D-045** — the agency's own log |
| Force a parked publish through | **D-027** — a person must look at the Page |

If you find yourself needing one of these regularly, that is a product conversation, not a
workaround to find.

---

## 6. Escalation

1. **Data exposure across tenants** — stop, capture the correlation id, do not "fix" the data.
   Anything cross-tenant is already logged as a `securityEvent`; that log is the evidence.
2. **A post published twice** — capture both external post ids and the `PublishingAttempt` chain
   before anything else. This is the failure the design exists to prevent, so the trail matters more
   than the cleanup.
3. **Meta App Review / Business Verification** — see `SOCIAL_PROVIDERS.md` §2. Not an incident, but
   it is the external dependency that gates real publishing.
