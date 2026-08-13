# AHN Orbit — Decision Log

> SRS §48. Every entry records **Decision · Reason · Alternatives considered · Impact · Date**.
> Append-only: when a decision changes, add a new entry that supersedes the old one rather than
> editing history. Update this file in the PR that makes the change, not afterwards.
>
> Status of every entry below: **PROPOSED** — none is ratified until the P0 questions in
> `00-ANALYSIS.md` §D are answered.

---

## D-001 — Monorepo (pnpm workspaces)

- **Decision:** One repository with `apps/web`, `apps/worker`, and shared `packages/*`.
- **Reason:** The web app and the worker must share the Prisma client, provider adapters, the RBAC
  engine, and domain types. Two repositories would duplicate all of it, violating §42.
- **Alternatives:** Separate repos with a published internal package (versioning overhead, slow
  iteration); a single Next.js app with no worker (impossible — see D-002).
- **Impact:** CI builds two deployable artifacts; boundary rules enforced by lint.
- **Date:** 2026-08-11 · **Status:** PROPOSED

## D-002 — Workers run on AWS ECS Fargate, not Vercel

- **Decision:** Next.js on Vercel; BullMQ workers as a container service on ECS Fargate.
- **Reason:** Vercel Functions are request-scoped and cap at 800s (1800s beta). A BullMQ worker is a
  long-lived process holding a blocking Redis connection — it is not expressible as a function. §51
  already names "Vercel + AWS", so this makes the split explicit rather than discovering it late.
- **Alternatives:** Vercel Cron polling a queue (poor latency, no concurrency control, still
  request-bounded); Inngest/QStash (removes BullMQ, adds a vendor and a different execution model —
  reasonable, but §27 names BullMQ); everything on AWS including the web app (loses Vercel's
  Next.js integration).
- **Impact:** A second deployment target, a Dockerfile, ECS task definitions, and autoscaling. The
  web app is forbidden from constructing a BullMQ `Worker`.
- **Date:** 2026-08-11 · **Status:** PROPOSED

## D-003 — Redis on Upstash for MVP

- **Decision:** Managed Redis reachable over public TLS from both Vercel and ECS.
- **Reason:** AWS ElastiCache is VPC-private and not reachable from Vercel serverless functions
  without Secure Compute (Enterprise) or a VPC/NAT arrangement. Upstash removes that problem on day
  one.
- **Alternatives:** ElastiCache + all enqueues proxied through an internal API on ECS (cheaper at
  scale, more moving parts now, and it couples the web app's availability to the worker's);
  ElastiCache + Vercel Enterprise (cost).
- **Impact:** Per-command pricing; BullMQ requires `maxRetriesPerRequest: null` and
  `enableReadyCheck: false`. Revisit if command volume makes it expensive.
- **Date:** 2026-08-11 · **Status:** PROPOSED — **blocked on Q2**

## D-004 — Firebase Auth for identity; authorization in Postgres

- **Decision:** Firebase Auth owns credentials, verification, reset, Google sign-in, and (later) MFA.
  Roles and memberships live in Postgres and are read on every request. Only `isPlatformAdmin` is
  mirrored into a custom claim.
- **Reason:** §51 mandates Firebase Auth. Custom claims cap at 1000 bytes, refresh lazily (up to an
  hour stale), and cannot express per-workspace/per-brand grants for a user in several orgs.
  Revocation must be immediate (§5: never trust role information from the client).
- **Alternatives:** All roles in custom claims (size and staleness); a second session store
  (redundant with the DB read we already make).
- **Impact:** One extra query per request, cached ~30s. A third cloud vendor (GCP) alongside Vercel
  and AWS — the Firebase dependency is confined to `packages/auth` so it stays replaceable.
- **Date:** 2026-08-11 · **Status:** PROPOSED

## D-005 — Tenant isolation: scoped data layer primary, RLS as backstop

- **Decision:** `organizationId` on every tenant table; a tenant-scoped Prisma client injects it into
  every query; Postgres RLS policies provide an independent second layer.
- **Reason:** §4 demands server-side isolation that survives manual API manipulation. One mechanism
  is a single point of failure; two independent ones are not.
- **Alternatives:** RLS only (fragile with Prisma's connection handling as the *sole* control);
  application checks only (one forgotten `where` is a breach); schema- or database-per-tenant
  (migration and ops burden unjustified at ~100 orgs).
- **Impact:** A `SET LOCAL` inside each transaction; a runtime guard that throws on un-scoped tenant
  queries; a mandatory cross-tenant 404 test per endpoint. Requires a Postgres where we can create
  roles and policies (**Q3**).
- **Date:** 2026-08-11 · **Status:** PROPOSED

## D-006 — `PostVariant` (per social account) is the unit of publishing

- **Decision:** One variant per (post × social account). Platform-level editing is a UI affordance
  that writes through to that platform's variants.
- **Reason:** External post IDs, failures, retries, and analytics are all per account. Two Pages on
  one post need two independent outcomes even with identical copy.
- **Alternatives:** Per-platform variants joined to accounts (same data, more indirection at publish
  time and an awkward place to store `externalPostId`).
- **Impact:** Adds `PARTIALLY_PUBLISHED` to the §10 status enum, since a post can succeed on one
  target and fail on another. Flagged for confirmation.
- **Date:** 2026-08-11 · **Status:** PROPOSED

## D-007 — Status and production stage are separate models

- **Decision:** `Post.status` implements the §10 lifecycle; `ProductionTask` rows implement the §11
  pipeline with their own assignees and states.
- **Reason:** §10 and §11 are different axes. A post can be in `DRAFT` while its *Design* stage is
  assigned and in progress. One flat enum cannot express that.
- **Alternatives:** A merged enum (loses assignment); stages as tags (no state or ownership).
- **Impact:** Two tables and a rule: a post cannot leave `DRAFT` while a blocking production task is
  open. `ProductionTask` ships in P0 as schema only; its UI is P1.
- **Date:** 2026-08-11 · **Status:** PROPOSED

## D-008 — Publishing idempotency: four layers, with reconciliation

- **Decision:** (1) deterministic BullMQ `jobId`; (2) an atomic DB claim
  (`UPDATE … WHERE status='SCHEDULED' RETURNING`); (3) a Redis lock per account around the provider
  call; (4) a **reconciliation read before any retry that follows an ambiguous outcome**.
- **Reason:** Facebook's `/feed` accepts no client idempotency key, so a timeout genuinely cannot be
  interpreted. §13 forbids double-publishing on retries, crashes, and timeout ambiguity — layers 1–3
  prevent concurrent duplicates but cannot resolve ambiguity; only layer 4 can.
- **Alternatives:** Retry blindly (double posts — unacceptable); never retry (spurious failures);
  a provider idempotency key (does not exist here).
- **Impact:** `reconcile()` added to the `SocialProvider` interface — a deliberate departure from
  §8's sketch, which §8 permits. An inconclusive reconciliation parks the variant in `NEEDS_REVIEW`
  for a human; the system never guesses.
- **Date:** 2026-08-11 · **Status:** PROPOSED

## D-009 — Scheduler sweeps the database; it does not create delayed jobs per post

- **Decision:** A repeatable job every 30s selects due variants (partial index) and enqueues them.
  Scheduling tolerance ±60s.
- **Reason:** Keeps the database the single source of truth. With one delayed job per post,
  rescheduling and cancellation become queue surgery, and a Redis loss loses the schedule.
- **Alternatives:** One delayed BullMQ job per variant (second-level precision, brittle on
  reschedule); a cron per minute (worse tolerance, same design).
- **Impact:** Publishing may land up to ~60s after the requested time. Confirm this is acceptable
  (`00-ANALYSIS.md` B12).
- **Date:** 2026-08-11 · **Status:** PROPOSED

## D-010 — Analytics metrics stored as jsonb with an availability map

- **Decision:** `metrics` and `availability` jsonb columns, plus the provider API version, on each
  snapshot. Metric names are provider-versioned configuration.
- **Reason:** Providers expose genuinely different metrics, and Meta's set is actively churning —
  `page_impressions` and `page_fans` were removed on 2025-11-15, with a further wave on 2026-06-15,
  and deprecated metrics now return an error rather than an empty result. §18 requires unavailable
  metrics to be *clearly indicated*, never fabricated.
- **Alternatives:** Typed columns per metric (a migration every provider change); a normalised
  metric/value table (more joins, slower charts).
- **Impact:** A typed accessor layer over jsonb; generated columns added later if profiling demands.
  Facebook figures will not match historical Meta Business Suite reports — the agency must be told
  before the first client report.
- **Date:** 2026-08-11 · **Status:** PROPOSED

## D-011 — Modular Next.js server, not NestJS

- **Decision:** Route handlers and server actions over domain services in `packages/core`.
- **Reason:** §27's stated default. NestJS would add a second runtime, deployment target, and DI
  framework for no benefit at this size; the genuinely non-HTTP work lives in the worker, which is a
  plain Node process.
- **Alternatives:** NestJS (§27 requires justification — we have none); a separate Express API
  (duplicates auth and tenancy).
- **Impact:** Domain logic must stay out of route handlers so the API can be extracted later if it
  ever needs to serve third parties at volume.
- **Date:** 2026-08-11 · **Status:** PROPOSED

## D-012 — Client portal is a separate surface, not a filtered agency view

- **Decision:** Its own route group, its own services, its own narrowed selects, its own tests.
- **Reason:** §21 requires that no internal information leaks. A shared endpoint with a role filter
  makes every future field addition a potential leak; the safe default must be structural.
- **Alternatives:** Shared endpoints with response filtering (one forgotten field is a breach);
  a separate application (duplicated auth and deployment).
- **Impact:** Some duplication between agency and portal read paths — accepted deliberately. Portal
  responses are asserted leak-free at the **payload** level in tests.
- **Date:** 2026-08-11 · **Status:** PROPOSED

## D-013 — Media: presigned direct upload, then server-side byte verification

- **Decision:** Browser uploads straight to S3 via a presigned `PUT`; a worker then verifies the
  actual bytes (magic number, real dimensions, duration) before the asset becomes `READY`.
- **Reason:** Keeps large files out of serverless functions, and §17 requires real MIME validation —
  a client-declared content type is an assertion, not a fact.
- **Alternatives:** Upload through the API (function size and duration limits); trust the declared
  MIME (unsafe).
- **Impact:** A two-phase upload UX; assets are unusable until verification passes. Object keys are
  derived from a generated id, never from the user's filename.
- **Date:** 2026-08-11 · **Status:** PROPOSED

## D-014 — Recommend a minimal approval gate in MVP

- **Decision:** `INTERNAL_REVIEW`, `CLIENT_REVIEW`, approve / request-changes, and a read-only client
  approval queue ship in P0. The full portal stays P1.
- **Reason:** §49 makes approval workflows the product's identity, and retrofitting an approval state
  machine beneath live published content is materially more expensive than building it now.
- **Alternatives:** Strict §39 phasing (approvals in Phase 2) — cheaper this month, more expensive
  overall, and the MVP would not be usable with real clients.
- **Impact:** ~8 points added to Phase 1. **This is a recommendation, not a unilateral scope change**
  — see **Q4**. If declined, the `Approval` schema ships anyway so the status enum does not change
  under live data.
- **Date:** 2026-08-11 · **Status:** PROPOSED — **blocked on Q4**

## D-015 — Composite tenant foreign keys

- **Decision:** Every reference between two tenant-scoped tables is a composite
  foreign key `(organizationId, childId) → Parent(organizationId, id)`, backed by
  a `@@unique([organizationId, id])` on each parent. 34 constraints, 12 new
  unique indexes.
- **Reason:** A single-column `brandId` foreign key only checks that the brand
  *exists*, not that it belongs to the same organization. The tenant-scoped
  client stamps `organizationId` correctly, so a mixed-tenant row was
  unreachable through any service that resolved its parents through that client
  — but that was a **convention**, not a guarantee, and conventions are exactly
  what a security model should not rest on. Found while writing the T1.2
  cross-tenant tests and originally shipped as a documented gap.
- **Alternatives:** application-level validation in every service (forgettable,
  and invisible when forgotten); a trigger per table (more moving parts, worse
  error messages); accepting the risk (rejected — the user asked for
  database-level guarantees wherever reasonably possible).
- **Impact:**
  - Optional references (`MediaAsset.brandId`/`.folderId`, `AIUsage.brandId`,
    `Post.sourceIdeaId`) changed from `SET NULL` to `NO ACTION`: `SET NULL` on a
    composite key would try to null `organizationId`, which is `NOT NULL`.
    `NO ACTION` is checked at end-of-statement, so a cascading organization
    delete still succeeds, while deleting a still-referenced brand or folder is
    refused. Brands and folders are soft-deleted in normal operation.
  - Nested creates now **inherit** `organizationId` from the parent and reject
    an explicit one — cross-tenant nesting became impossible by construction.
  - `User` references (`createdById`, `assignedToId`, `uploadedById`, …) cannot
    be composite: a user genuinely spans organizations, so no
    `(organizationId, id)` key exists for them. These remain application-enforced
    and are the one residual gap — see the note below.
- **Date:** 2026-08-11 · **Status:** IMPLEMENTED (migration
  `20260811000400_composite_tenant_foreign_keys`)

---

## D-016 — The edit lock applies to content edits, not to transitions

- **Context:** `post:update` carries `requiresEditable`, and
  `assertTransitionAllowed` evaluates a transition's permission against the
  **source** status. The reopen transitions (`APPROVED → DRAFT`,
  `SCHEDULED → DRAFT`) are therefore checked with an edit-locked source, so the
  policy denied them for every role including Owner. The transition table's
  `voidsApprovals: true` on those two rules was unreachable code, and there was
  no way back from APPROVED at all. Found by a T1.9 integration test, not by
  inspection.
- **Options:**
  1. Give reopening its own permission (`post:reopen`) and grant rows.
  2. Exempt transitions from the `requiresEditable` gate.
  3. Drop `requiresEditable` from `post:update` and rely on the service's
     `assertEditable`.
- **Decision:** option 2. `ResourceScope` gained
  `intent?: 'EDIT' | 'TRANSITION'`, defaulting to `EDIT`, and the
  `requiresEditable` gate is skipped only for `TRANSITION`.
- **Why:** the edit lock exists to stop *content* being mutated after approval,
  which is what `updatePost`'s `assertEditable` enforces directly. For a status
  change the transition table is already the authority on what is legal from a
  locked status, and it deliberately lists exactly the reopen and cancel paths.
  Option 1 adds a permission that would have to be granted to every role that
  can already edit, restating the same fact twice. Option 3 would remove the
  lock from the policy layer entirely, weakening `can()` for the UI.
- **What this does not weaken:** `intent: 'TRANSITION'` is set in exactly one
  place — `assertTransitionAllowed`, and only *after* the state machine has
  confirmed the transition exists. The reachable set from a locked status is
  still precisely the transition table's. Status-restricted grants
  (`grant.statuses`, e.g. a Client only at `CLIENT_REVIEW`) are unaffected, and
  content mutation still evaluates as `EDIT`. All three properties are pinned by
  unit tests in `packages/rbac/src/policy.test.ts`.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-017 — Approvals ride the post state machine; they are not a second one

- **Context:** T1.10 needed a way to record review decisions. An `Approval` table
  with its own `state` could easily have become a parallel workflow engine, with
  two places that decide where a post goes and an inevitable drift between them.
- **Decision:** `decideApproval` computes the resulting status from pure domain
  logic (`packages/core/approvals.ts`), then calls `transitionPost` — the same
  machine, the same permission check, the same validation, the same audit row as
  the direct `/transition` endpoint. The decision row is stamped inside that
  transition's transaction via an `onTransition` hook, so it commits with the
  status change or not at all. Gates are opened by the transition too, never by
  a separate endpoint.
- **Consequences:** there is exactly one path a post's status can move along.
  A reviewer who lacks the right for the resulting transition is refused by the
  existing grant matrix, with no approval-specific authorization code to keep in
  step.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-018 — `Post.approvalRequired` means *client* approval, and cannot be skipped

- **Context:** `docs/RBAC.md` §5 records `INTERNAL_REVIEW → APPROVED` as
  available to Acct Mgr, Admin and Owner *"when client approval is not
  required"*. Nothing enforced the parenthetical: T1.9 let an internal approver
  move any post straight to APPROVED, skipping the client entirely.
- **Decision:** `Post.approvalRequired` (default `true`) means the client gate
  applies. While it does, `INTERNAL_REVIEW → APPROVED` is refused with a 409 for
  every role including Owner, and the only way on is `CLIENT_REVIEW`. Approving
  the internal gate on such a post therefore *sends it to the client* rather than
  finishing review — which is what `statusAfterDecision` encodes.
- **Why not the transition table:** the rule depends on the post's own data, not
  on the status pair, so the table cannot express it. It lives in
  `transitionPost` beside the other post-dependent guards.
- **Note for review:** this makes the default posture "the client must approve".
  Agencies that work on standing approval will set `approvalRequired: false` per
  post; a workspace- or brand-level default is a reasonable later addition.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-019 — Leaving a review status closes the gate, independently of `voidsApprovals`

- **Context:** found by a T1.10 integration test. Gates were closed only on
  transitions marked `voidsApprovals` (the two reopens). Requesting changes from
  `CLIENT_REVIEW` moves the post on but is not a reopen — so the client's gate
  stayed `PENDING` in their queue forever, on a post that was no longer with them.
- **Decision:** two distinct rules, kept apart in `transitionPost`:
  *the post left the status the gate belonged to* (close it, whatever moved it),
  and *this transition invalidates approvals already granted* (`voidsApprovals`).
  Cancelling closes gates too.
- **Ordering:** the `onTransition` hook runs *before* the gate bookkeeping,
  because a reviewer's decision stamps the very record that bookkeeping would
  otherwise cancel. Once stamped it is no longer `PENDING` and is left alone.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-020 — Retry policy lives in the worker, not in BullMQ's `attempts`

- **Context:** BullMQ can retry a job itself with `attempts` + `backoff`. Using
  it would have been less code.
- **Decision:** jobs are added with `attempts: 1`. A failed attempt is
  re-enqueued deliberately by `runAttempt` after `decideRetry` has consulted the
  error taxonomy, with the attempt number carried in the payload.
- **Why:** BullMQ's attempt counter cannot express two of our three outcomes.
  A **rate limit** must reschedule at the provider's `retryAfter` *without*
  consuming an attempt — otherwise a busy queue turns into a failed post. A
  **`PublishingTimeoutError`** must not be retried at all until something has
  reconciled with the provider, because the post may already exist; encoding it
  as a number would silently convert an ambiguous publish into a duplicate one.
  Retryability is a property of the error, which `AppError.retryable` already
  records, so a new provider error gets correct behaviour with nothing to update
  in the queue layer.
- **Cost:** we own the re-enqueue path, including the `__attempt` field. The
  whole decision surface is pure and unit-tested without Redis.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-021 — A job's tenant is derived from its subject row, never from its payload

- **Context:** a job payload must name its work, and that includes an
  `organizationId`. Handing the worker a scoped client built from that value
  would make the queue a trust boundary we do not control: a queue is durable
  shared state, and a stale job, a hand-inserted entry or a producer bug could
  all put the wrong tenant there.
- **Decision:** every tenant-scoped processor resolves its subject row by
  primary key first and derives the tenant from **that row**. The payload's
  `organizationId` is only ever *compared*; a mismatch is a
  `TenantIsolationError` and a `securityEvent` log line, and the job fails.
  `resolveJobTenant` is the only sanctioned path, and `resolveTenantForJob` in
  `apps/worker/src/context.ts` is the only place an unscoped read happens —
  selecting nothing but `organizationId`, to *build* a scope rather than bypass
  one.
- **Note:** this supersedes the comment in `packages/auth/src/system.ts` that
  said "the organization id still comes from the job payload". It no longer
  does.
- **Why not reconcile in favour of one side:** both readings cannot be right,
  and guessing which is the actual hazard.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-022 — The web app produces; only the worker consumes

- **Context:** T1.11's DoD requires that the web app never constructs a
  `Worker`. Next.js makes this easy to violate by accident — an import in a
  shared module is all it takes.
- **Decision:** three independent guards. `@orbit/queue` splits into a producer
  half (`enqueue`, `cancelJob`, `queueDepths`) and a consumer half
  (`startWorker`, `blockingConnection`, `installShutdownHandlers`); ESLint
  refuses the consumer imports from `apps/web`; and `assertWorkerProcess()`
  throws at runtime unless `ORBIT_ROLE=worker`.
- **Why all three:** the lint rule catches the mistake at authoring time, the
  runtime guard catches the *deployment* mistake of running a bundle with the
  wrong role, and the module split makes the boundary legible without either.
  A `Worker` inside a web server would hold blocking Redis connections across
  request lifecycles it does not control, start one consumer per instance, and
  make queue concurrency a side effect of HTTP autoscaling.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-023 — DST edges resolve differently for a picked time and a recurring slot

- **Context:** a wall-clock time in a zone does not always name exactly one
  instant. Spring forward leaves a **gap** (02:30 never happens), autumn back
  leaves an **overlap** (01:30 happens twice). Every scheduling feature has to
  decide what those mean, and the honest answer differs by case.
- **Decision:**
  - A **time a person picked** that falls in a gap is **rejected**, with a
    message saying the clocks go forward and to pick again. Silently moving
    someone's 01:30 to 02:30 is a worse surprise than an error at the moment
    they can still fix it.
  - A **recurring queue slot** in a gap **shifts forward** to the first instant
    that exists. Rejecting would silently drop one week's post twice a year,
    which is a bigger failure than publishing half an hour late once.
  - An **overlap** takes the **earlier** occurrence in both cases. Publishing
    early is more predictable than publishing late, and the alternative is
    arbitrary.
- **Implementation:** `NonexistentTimePolicy` and `AmbiguousTimePolicy` in
  `packages/core/src/timezone.ts`; the defaults differ between `resolveSchedule`
  (REJECT) and `nextQueueSlot` (SHIFT_FORWARD). An ambiguous schedule is logged
  so a support question has an answer.
- **Both transitions are asserted explicitly** in `timezone.test.ts` for
  `Europe/London`, `America/New_York` (different dates from Europe — where naive
  code breaks) and `Australia/Sydney` (southern hemisphere, inverted seasons),
  with `Asia/Ho_Chi_Minh` proving a no-DST zone stays boring.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-024 — Timezone arithmetic uses `Intl`, not a library

- **Context:** scheduling needs IANA zone conversion including DST. The obvious
  move is `date-fns-tz` or `luxon`.
- **Decision:** neither. Node ships full ICU, so `Intl.DateTimeFormat` with a
  `timeZone` gives the tz database directly, and the conversions we actually
  need are about sixty lines.
- **Why:** a timezone library's value is its bundled tz data, which is also its
  liability — stale data means wrong publish times, and remembering to bump it
  is exactly the maintenance that gets skipped. Node's ICU updates with Node.
  The dependency would also have crossed into `packages/core`, which currently
  has none beyond Node built-ins.
- **Cost:** we own the gap/overlap logic. It is pure, and covered by 33 tests
  including both transitions in three zones.
- **Note:** the first implementation had a real bug — it probed only *forward*
  from its first guess and so missed overlaps where that guess had already
  landed on the later occurrence (London, unlike New York). The current version
  enumerates every instant matching the wall time and classifies by count, so
  there is no direction to get backwards.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-025 — The scheduler sweep gets its own queue

- **Context:** T1.11 shipped `maintenance` at concurrency 1 for housekeeping.
  The 30-second sweep could have shared it.
- **Decision:** a separate `scheduler` queue, also concurrency 1, carrying
  `sweep-due` and `report-stale`.
- **Why:** at concurrency 1 a slow retention pass would delay the sweep, and a
  late sweep means posts publish late — the one thing scheduling exists to get
  right. Repeat interval is `every: 30_000` rather than a cron pattern, because
  cron's finest granularity is a minute, which would double worst-case
  lateness against assumption C10's ±60s.
- **Sweep safety:** the `PublishingJob` unique on `(postVariantId,
  idempotencyKey)` makes a concurrent sweep a no-op rather than a twin, and that
  same key is the BullMQ job id, so a duplicate add is dropped. Proven by a test
  that runs three sweeps concurrently and asserts one job.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-026 — The post travels through `PUBLISHING` too, not just the variant

- **Context:** the engine claimed each `PostVariant` into `PUBLISHING` but left
  the *post* at `SCHEDULED`, then tried to settle it directly to `PUBLISHED`.
  That transition does not exist: the table has `SCHEDULED → PUBLISHING` and
  `PUBLISHING → PUBLISHED | PARTIALLY_PUBLISHED | FAILED`, both SYSTEM-only.
- **Found by:** `assertTransition` refusing it in the rollup — the machine
  caught the engine's bug, which is what consulting it there was for. Six
  integration tests failed on the first run.
- **Decision:** `markPostPublishing` moves the post `SCHEDULED → PUBLISHING`
  when its first variant is claimed. Idempotent and status-guarded, so the
  second and third accounts of a multi-account post find it already moved.
- **Consequence worth knowing:** a post mid-publish now reads `PUBLISHING`
  rather than `SCHEDULED`, which is both more accurate and what the edit lock
  already assumed (`PUBLISHING` is in `EDIT_LOCKED_STATUSES`).
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-027 — An unresolved publish parks; it never retries

- **Context:** Facebook's `/feed` accepts no idempotency key, so a timeout is
  genuinely ambiguous — the post may or may not exist. Something has to decide
  what happens next.
- **Decision:** three outcomes, and only one of them retries.
  - **Reconciliation says FOUND** → treat as published, adopt the external id,
    record the attempt as `RECONCILED` rather than `SUCCEEDED` so the trail
    shows we learned of it after the fact.
  - **Reconciliation says NOT_FOUND** → confirmed absent, so retrying is safe.
  - **Reconciliation is INCONCLUSIVE, fails, or the provider is not
    `reconcilable`** → the variant parks in `NEEDS_REVIEW` and *nothing
    automated touches it again*. A human decides.
- **Why parking rather than retrying:** the failure modes are not symmetric. A
  post that goes out late is an inconvenience; a post that goes out twice on a
  client's Page is a phone call from the client. When we cannot tell which
  we're risking, we stop.
- **Reconciliation matches on `contentHash`** within ±10 minutes of the attempt
  — wide enough for a slow provider, narrow enough that the same caption reused
  next week cannot be mistaken for ours. Tested: an unrelated post on the same
  Page is not adopted.
- **Retry never touches a parked variant.** `retryFailedVariants` selects
  `status: 'FAILED'` only; `PUBLISHED` and `NEEDS_REVIEW` are both excluded.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-028 — "Publish now" is scheduling for the present

- **Context:** `publish-now` could have been a separate path straight to the
  queue.
- **Decision:** it is not. It runs the same `APPROVED → SCHEDULED` transition,
  stamps the same content hash, derives the same idempotency key, and creates
  the same `PublishingJob` row — the only difference is that the instant is now
  and the job is enqueued directly rather than waiting up to 30s for the sweep.
- **Why:** two doors into the publishing engine would be two chances to get
  idempotency wrong. This way a "publish now" that races the sweep produces an
  identical key and BullMQ drops the duplicate, with no special case anywhere.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-029 — A parked publish is resolved by a person, on the record

- **Context:** T1.13 parks a variant in `NEEDS_REVIEW` when it cannot establish
  whether a post went out, and nothing automated touches it again (**D-027**).
  That was correct and incomplete: it left no way out. A parked variant would
  have sat there forever.
- **Decision:** three answers, all requiring a reason, all audited as security
  events:
  - **"It published"** → `PUBLISHED`. Requires the external post id (see below).
  - **"It did not publish"** → `SCHEDULED` at a new instant, which yields a new
    idempotency key and hands straight back to T1.13's engine. No publishing
    happens here.
  - **"Leave it"** → `FAILED`.
- **Why a reason is mandatory for all three:** each is a person overriding a
  machine that said "I don't know", and in six months someone will need to know
  how they knew. The same rationale as `onBehalfOf` in the approval flow.
- **Permission:** `post:retry_failed`, reused rather than adding one. It is
  already the "fix a broken publish" right and already restricted to Owner,
  Admin and Account Manager. Adding a permission would have changed the RBAC
  matrix for no gain in precision.
- **Why the retry path does not publish directly:** it returns the variant to
  the engine, so all four idempotency layers apply again. There is no second
  door into publishing.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-030 — Confirming a publish requires naming the post

- **Context:** the first implementation let a person mark a parked variant
  `PUBLISHED` without supplying an external post id.
- **Found by:** the DB check constraint `PostVariant_published_requires_external_id`
  rejecting the write during integration tests — the second time a constraint
  written in T0.3 has caught a defect the application layer missed.
- **Decision:** `externalPostId` is required when the resolution is
  `PUBLISHED`, enforced in the zod contract, the service, and the UI.
- **Why the constraint is right:** a variant marked published with nothing to
  point at is an unverifiable claim. It also breaks two things downstream —
  reconciliation matches on the external id, and analytics fetches by it.
- **Consequence:** the operator has to copy the id or link from the platform.
  That is a small cost for a record that can be checked later, and they are
  already looking at the post in order to answer the question.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-031 — Health probes get their own rate-limit bucket

- **Context:** T1.7 adds a second thing that calls a provider per account. Both
  publishing and health probes spend the same quota at Meta, so sharing one
  token bucket per `(platform, account)` is defensible in theory.
- **Decision:** a separate key namespace, `ratelimit:health:{platform}:{id}`,
  with its own small budget (`healthRateLimitKey` in
  `packages/queue/src/rate-limit.ts`).
- **Why:** the two workloads have opposite shapes. The health sweep touches
  **every** connected account on the hour; publishing is bursty and has a
  deadline. A shared bucket would let the sweep drain the budget at exactly the
  moment it ran, deferring real publishes — and the symptom, posts going out
  late on the hour, would look nothing like its cause. With separate keys a
  health sweep can only starve health probes, which retry an hour later and cost
  nothing.
- **What this does not weaken:** the provider's actual ceiling is still
  respected, because the adapter narrows buckets adaptively from the
  `X-App-Usage` headers it parses after every call — that applies to whichever
  bucket the call was made against.
- **Alternatives:** one shared bucket (rejected: publishing loses to
  housekeeping); no limit on probes at all (rejected: an hourly sweep across a
  large tenant is exactly the burst a provider counts).
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-032 — A broken account pauses at the sweep as well as at the engine

- **Context:** T1.13's engine already refuses to publish through a non-`ACTIVE`
  account (`subject.ts`). That is the guarantee. But the scheduler sweep still
  enqueued those variants, so every 30 seconds each one produced a job, an
  attempt row, a log line and a failure — while the accounts page said nothing
  was wrong.
- **Decision:** the sweep filters on `socialAccount.status = 'ACTIVE'`, and
  counts what it skipped as `paused` so "nothing was due" and "everything due is
  stuck behind a broken account" stop looking identical in the log.
- **What this is not:** cancelling. The variants stay `SCHEDULED` with their
  times intact, so reconnecting the account is all it takes for the next sweep
  to pick them up — which is what makes the reconnect flow a fix rather than a
  fresh start. Pinned by an integration test.
- **Defence in depth is deliberate:** the engine keeps its own `ACTIVE` check.
  The sweep filter is a cheaper first pass, not a replacement for the guard that
  actually guarantees nothing publishes through a dead credential.
- **Consequence worth knowing:** a post whose account is broken passes its
  scheduled time silently and is reported by `reportStaleSchedules` once it is
  too late to publish unattended. That is the correct outcome — the alternative
  is publishing a "good morning" at 4pm — but it does mean the banner is what
  people act on, not the calendar.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-033 — Health notifications are written now, delivered in T1.15

- **Context:** T1.7's definition of done includes notifying someone when an
  account breaks. T1.15 (notifications) is not built, and building a delivery
  path inside T1.7 would have meant inventing the thing T1.15 exists to design.
- **Decision:** the `Notification` row is written, in the same transaction as
  the status change. Nothing is delivered. T1.15 owns the in-app centre, the
  email fan-out and the digest rules.
- **Why write it now rather than defer entirely:** a breakage during the gap
  would otherwise be lost, and T1.15 gets real rows to build against instead of
  fixtures.
- **Recipients are derived, not listed.** `rolesWithPermission` reads the grant
  matrix backwards to find who holds `social_account:reconnect`, and the grant's
  reach decides whether a workspace membership is also required. A hardcoded
  `['OWNER', 'ADMIN']` would be correct on the day it was typed and silently
  wrong — in the quiet direction — the first time the matrix moved.
- **Notifications fire on the transition, never on the state.** An account left
  broken over a weekend produces one notification, not one an hour.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-034 — Notifications ship in-app only; email is a seam, not a stub

- **Context:** T1.15's scope names email, and `RESEND_API_KEY` / `EMAIL_FROM`
  are already in the env schema. Wiring it would mean sending real mail to real
  client addresses from an environment that has never published a real post.
- **Decision:** in-app only. `channelsFor(type, preferences)` returns
  `['IN_APP']`, every producer already writes one row per returned channel, and
  `EMAIL_DELIVERY_ENABLED` is exported so the UI can decline to offer toggles
  that would do nothing.
- **Why this shape rather than a stub sender:** the `Notification` row *is* the
  outbox. `NotificationChannel` and `Notification.emailedAt` were in the schema
  from T0.3, so adding email is (1) return `'EMAIL'` from `channelsFor` when the
  preference allows, and (2) a processor branch that reads unsent rows, sends,
  and stamps `emailedAt`. No producer changes, no domain change, no migration.
  A stub sender would have had to be unpicked instead.
- **Consequence for the DoD:** "email failure does not lose the in-app record"
  cannot be tested literally yet. What *is* tested is the invariant that makes
  it true — `channelsFor` never returns an empty list, so the in-app row is
  written independently of any delivery outcome.
- **Preferences are not persisted.** `User` has no preferences column, and
  adding one before there is a channel to opt out of would be a migration in
  search of a purpose. `DeliveryPreferences` is threaded through so the column
  can arrive later without touching callers.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED (user decision: in-app only,
  no real email)

---

## D-035 — Fan-out is authorized, not addressed

- **Context:** a notification is a **disclosure pushed at someone**. Its title
  carries a post's name, an account's name, sometimes a quoted review note.
  Sending one to a person who could not open the resource leaks exactly what
  RBAC exists to withhold, and leaks it more aggressively than an endpoint they
  would have had to think to call.
- **Decision:** `resolveRecipients` asks two questions, in order, and both must
  pass:
  1. **interest** — does this person hold the permission that makes the event
     their business? Derived from the grant matrix, never a role list.
  2. **visibility** — can they read the underlying resource? Evaluated with
     `can()` from `@orbit/rbac` against a principal rebuilt from live
     memberships, so there is no second implementation of the rules.
- **Named individuals are still filtered.** A post's author is *included* for
  `post.changes_requested`, but a creator since removed from the workspace is
  still not told: being the author is interest, never access.
- **Proven by the negative tests**, which are the ones that matter: an approver
  in another workspace, an approver whose workspace role lacks
  `requiresApprovalRight`, a Client whose `post:read` is status-restricted to
  `CLIENT_REVIEW` and later, and a member of another organization all receive
  nothing.
- **Found while writing it:** the first version of the test seeded an Approver
  with the workspace role `CONTRIBUTOR` and expected them to be notified. The
  engine refused, correctly — `post:approve_internal` carries
  `requiresApprovalRight`. The seed was wrong, not the code, and the case is now
  pinned as its own test.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-036 — `packages/notifications`, and what it absorbed

- **Context:** T1.7 shipped account-health notification writing duplicated in
  `apps/web` and `apps/worker`, flagged as a residual gap. T1.15 would have
  added a second, larger duplication: both processes raise notifications, and
  the fan-out logic is security-critical.
- **Decision:** a package. It holds the notification types, the copy, channel
  selection, recipient resolution, the writer and the reader.
- **Why this is consistent rather than a new pattern:** it is shaped exactly
  like `@orbit/auth` — domain decisions plus the data access they need, with
  `@orbit/rbac` making every authorization call. `packages/core` stays pure and
  dependency-free, which is what lets `@orbit/notifications` depend on it rather
  than the reverse.
- **What it absorbed:** `healthNotification` moved out of
  `packages/core/account-health.ts`, and `apps/worker/src/health/recipients.ts`
  was deleted outright. The T1.7 duplication is down from ~80 lines to the
  status update and the audit row — and the audit row is *meant* to differ (a
  person asked for a web probe; the worker's is `WORKER`).
- **`rolesWithPermission`** stays in `@orbit/rbac`, where a question about the
  matrix belongs.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-037 — Some notifications are written inline; most are queued

- **Context:** two producers with opposite needs. Account health must not be
  marked broken without someone being told. A failed publish must not have its
  recorded outcome undone because a fan-out failed.
- **Decision:** both, deliberately.
  - **Inline, in the caller's transaction** — account health (T1.7). `notify`
    takes a `db` handle, so the status change and the notification commit
    together or not at all.
  - **Queued** — publishing failures and review transitions. Fan-out reads every
    membership in the organization and runs the policy engine over each, which
    has no business on the publish path or inside a user's request. Both
    producers swallow enqueue failures: the transition and the publish outcome
    are the record, the notification is a prompt.
- **Transitions enqueue after the commit**, never inside it. A notification
  about a transition that rolled back would be a lie, and BullMQ has no idea
  what Postgres decided.
- **The payload names the subject, never the audience.** Recipients and display
  facts are both resolved by the processor — a job queued before an edit
  describes what the post *is*, and a stale job cannot carry a stale audience.
- **One deliberate exception to "no identity in payloads":** `actorUserId`, used
  *only* to suppress self-notification. It can remove a recipient and never add
  one, so a wrong or forged value costs someone a notification they would have
  ignored. That asymmetry is what makes it safe, and it is why `organizationId`
  is still a checked assertion (**D-021**) while this is not.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-038 — The portal is client-only, and the agency API is client-free

- **Context:** `docs/RBAC.md` §1 rule 3 says a Client "can only reach the
  `(portal)` routes". Only half of that was enforced. A Client holding
  `post:read` reached `GET /orgs/{slug}/posts` and got a **200**: the status
  narrowing worked, so nothing they were forbidden to know about appeared, but
  the payload was shaped for the agency — `createdById`, `assignedToId`,
  `approvalRequired`, and per-account publishing state on every variant.
- **Decision:** both directions are now closed.
  - `withAuth` refuses a `CLIENT` principal on **every** agency route.
  - `withPortalAuth` refuses every non-`CLIENT` principal on **every** portal
    route.
- **Both are 404, not 403.** A 403 would confirm the endpoint exists, which is
  the same reason cross-tenant reads are 404 everywhere else (docs/API.md §1).
- **Why in the wrapper rather than per endpoint:** a per-endpoint check is one
  somebody forgets to add to the next endpoint, and the failure is silent. There
  is exactly one place each surface is entered, so there is exactly one place to
  put the rule.
- **Consequence worth knowing:** agency staff cannot preview the portal. That is
  a real product want (an account manager wanting to see what their client sees)
  and it is deliberately not built — the narrowed projections are calibrated to a
  Client, and admitting other roles would mean repeating every leakage test per
  role. If it is wanted later, the honest shape is an explicit, audited
  "view as client" rather than widening this rule.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-039 — The portal owns its reads; it delegates its writes

- **Context:** **D-012** requires the portal to be a separate surface rather than
  the agency endpoints with a filter. Taken literally for *writes*, that would
  mean a portal-local implementation of "approve" — which is the second state
  machine that **D-017** exists to prevent.
- **Decision:** split by direction.
  - **Reads** are portal-owned end to end: `features/portal/projection.ts`
    (allowlist selects), `features/portal/service.ts` (its own queries), its own
    routes, its own tests. No agency read path is reused.
  - **Writes** delegate. A decision goes through `decideApproval` → `transitionPost`
    → the one state machine; a comment goes through `createComment`, which
    already forces a Client's comment to `CLIENT_VISIBLE`.
- **Why this is not a contradiction of D-012:** D-012's hazard is *disclosure* —
  "one forgotten field is a breach" — and disclosure happens on the way out. A
  write has no payload to leak; its risk is inconsistent workflow, and the
  mitigation for that is the opposite one. So: two read paths, one write path.
- **The delegated result is re-read through the portal projection** before it is
  returned, because `decideApproval` hands back the agency post object.
- **Both layers authorize independently.** The portal route checks
  `post:approve_client` against the post's own status, and `decideApproval`
  re-checks the gate and the transition. Neither relies on the other having run.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-040 — The client's status vocabulary is a translation, not a second model

- **Context:** `CLIENT_REVIEW` is the agency's name for a queue; to the person
  in it, the useful sentence is "waiting for your approval". The temptation is a
  client-facing status enum.
- **Decision:** no second enum. `PostStatus` is unchanged and the state machine
  is untouched; the portal has a presentation map keyed on
  `CLIENT_VISIBLE_STATUSES`, so a status a client must never see has no label to
  render and cannot acquire one by accident.
- **`PARTIALLY_PUBLISHED` reads as "Published".** The client sees the accounts
  that went out and is not shown the one that did not. A variant parked in
  `NEEDS_REVIEW` (**D-027**) is a question the agency must answer first; a red
  badge discovered by a client at the weekend converts an operational hiccup
  into a client-relationship problem. The published view lists only variants
  that actually published, which makes this consistent rather than a special case.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-041 — The dashboard is gated on `org:read`, not `post:read`

- **Context:** T1.17 needs a permission for an organization-wide overview. The
  obvious choice, `post:read`, is **workspace- or brand-scoped** for every role
  below Admin — so `assertCan(ctx, 'post:read', {})` with no `workspaceId`
  denies a Content Creator with `MISSING_SCOPE_INFORMATION`. An overview cannot
  require the workspace id it exists to summarise.
- **Decision:** gate on `org:read`, which every internal role holds `ORG`-wide
  and `CLIENT` does not hold at all.
- **The permission opens the page; it does not decide the contents.** Every
  figure is narrowed by `accessibleWorkspaceIds`, so an Account Manager's
  dashboard counts their clients and an Owner's counts all of them. The
  account-health section is additionally gated on `social_account:read` inside
  the service and is **omitted** rather than zeroed when the caller lacks it —
  an empty section reads as "no problems", which would be a lie.
- **No new permission and no matrix change.** Adding `dashboard:read` would have
  restated a fact the matrix already encodes.
- **Clients are doubly excluded**: no `org:read`, and `withAuth` refuses them
  outright (**D-038**).
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-042 — Prisma query events are emitted outside production

- **Context:** T1.17's DoD requires the dashboard aggregation to be "a single
  grouped query, not N+1", and that property is worth a test rather than a
  comment. It turned out to be unobservable: Prisma 6 removed `$use`,
  `$extends` returns a *new* client rather than instrumenting the existing one,
  and `$on('query')` only delivers if the emitter was configured at
  construction — which it was for `development` only, while vitest runs as
  `test`.
- **Decision:** `packages/db/src/client.ts` now emits query events for every
  environment except production.
- **Why this is safe:** `emit: 'event'` sends nothing to stdout. With no
  subscriber it is inert, so this changes no output and no behaviour; it only
  makes query volume *observable* to something that asks.
- **What it bought:** `dashboard.integration.test.ts` runs the same call against
  two workspaces and then six and asserts the query count is **identical**. That
  tests the property the DoD asks for rather than pinning a magic number that
  would need editing whenever a section is added. It was verified to have teeth
  by temporarily adding a per-workspace count: 14 queries became 18.
- **A guard against a vacuous pass** is part of the test — it asserts the
  observed count is greater than zero, which is what caught the emitter being
  off in the first place.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-043 — The admin surface is a third wrapper, with no tenant context at all

- **Context:** platform administration could have been `withAuth` plus a flag.
  It is not, because docs/RBAC.md §1 rule 4 draws a line that a boolean would
  blur: platform admins operate the SaaS, they do not act inside an
  organization.
- **Decision:** `withPlatformAdmin` is a third wrapper alongside `withAuth`
  (agency) and `withPortalAuth` (client). It produces **a user and no
  `TenantContext`**.
- **Why that matters more than a check:** the tenant-scoped Prisma client is
  only constructible from a `TenantContext`. With none in scope, an admin
  handler *cannot* call `withTenant` — reading client content is unreachable
  rather than merely forbidden. The admin service uses `platformDb` with
  explicit allowlist selects, and no query in it touches `SocialCredential`,
  `Post.body`, `Comment` or `MediaAsset`.
- **`isPlatformAdmin` comes from the `User` row**, never the Firebase claim
  (rule 2). `resolveUser` reads it on every request.
- **404, not 403**, for everyone else — the admin API's shape is not something a
  tenant user gets to discover (docs/API.md §1).
- **Permissions reused, not added.** `admin:view_jobs` covers jobs and health;
  `admin:retry_job` covers the two mutating routes; `admin:view_system_logs` is
  read as the "see system state" permission and covers organizations, users and
  connection status — which is exactly how docs/RBAC.md §2 describes the role.
  No new permission and no matrix change.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-044 — A platform admin sees connection *status*, not connection *identity*

- **Context:** the account-status board needs to say something useful about a
  broken connection. The tempting field is the account's display name.
- **Decision:** status, platform, organization and `healthCheckedAt`. **Not**
  `displayName`, `handle`, `externalId` or `healthError`.
- **Why:** docs/RBAC.md §3 note 2 grants a platform admin "connected /
  needs-reconnect / revoked" and nothing else, and *which Pages a client
  manages* is the client's commercial information rather than platform state.
  The useful operational sentence — "this organization has a connection that has
  been broken since Tuesday" — needs none of the identifying fields, and the
  agency's own accounts page has them.
- **`healthError` is excluded for the same reason**: it is a provider message
  about one customer's connection.
- **Asserted by a test** that seeds a real sealed credential and a real Page id,
  then greps every admin payload for both.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-045 — An admin cannot re-enqueue a `publish` job

- **Context:** `POST /admin/jobs/{id}/retry` is in docs/API.md §2.13, and the
  dead-letter set contains publish jobs like any other.
- **Decision:** every queue except `publish` may be re-enqueued from the admin
  panel. A publish dead letter is browsable and discardable, and the retry is
  refused with a message pointing at the tenant's own publishing log.
- **Why:** **D-028** and **D-029** are both about publishing having exactly one
  door. An admin re-enqueue would be a second one, entered without the post's
  current content, without the tenant's approval state, and invisible to the
  agency whose client's Page it would post to. The tenant-side routes already
  exist — T1.14's per-job retry and D-029's parked-variant resolution — and both
  run inside the tenant, with its permissions, through the same engine and the
  same four idempotency layers.
- **What this costs:** an operator cannot unstick a publish for a customer
  directly. They can see it, explain it, and ask the agency to retry. That is a
  worse support experience and a better safety property, and the failure mode it
  avoids — a post going out twice on a client's Page — is the one the whole
  publishing design is organised around.
- **The endpoint reports it**: `GET /admin/jobs/{id}` returns
  `retryable: false`, so the UI does not offer a button that would be refused.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED — **worth your review**, since
  it narrows an endpoint the API doc describes without qualification.

---

## D-046 — Admin actions on tenant data land in the tenant's own audit log

- **Context:** T1.18's DoD requires admin actions against tenant data to be
  audited with an actor and a reason. A platform admin has no membership in the
  organization, so there is no scoped client to write through.
- **Decision:** `platformAudit` writes one row into the **affected
  organization's** `AuditLog` via `platformDb`, naming the administrator as
  `actorUserId` with a mandatory, validated `reason`, and emits a
  `securityEvent` log line alongside.
- **Why the tenant's log rather than a separate admin log:** the agency should
  be able to see what we did to them. A support action recorded only where
  support can read it is a record kept for the wrong party.
- **Narrowness is what makes an unscoped write acceptable here:** the helper can
  only append to `AuditLog`, the reason is validated before anything is written,
  and the audit is written *before* the action — an unaudited action is the
  outcome to avoid, not an unfulfilled one.
- **Jobs with no tenant** (a maintenance sweep, a scheduler pass) have no audit
  log to write into; those record to the security log with the same actor and
  reason.
- **Found while building:** `AuditLog.resourceId` is `@db.Uuid` and a
  dead-letter id is a Redis key (`{queue}:{jobId}:{timestamp}`), so the first
  version failed on a Postgres cast at the end of the request. `platformAudit`
  now rejects a non-UUID `resourceId` as a programming error, and such
  identifiers travel in the `before` snapshot instead.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-047 — Tests never call a real platform unless asked by name

- **Context:** `ensureProvidersRegistered()` picks the real Facebook adapter whenever
  `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET` are set — which is the normal state
  of a developer's `.env`. It is reached from `validatePost`, and therefore from
  **any post transition**.
- **Found by:** the first run of the §32 E2E flow, which registered `MockProvider`
  in `beforeAll`, had it silently replaced at step 6, and **published to
  `graph.facebook.com`** — failing on a genuine `OAuthException` from Meta. The
  test was one valid token away from posting to a real Page.
- **Decision:** in `NODE_ENV=test` the mock is registered regardless of
  configuration. The single exception is `ORBIT_E2E_REAL_PROVIDER=true`, which
  exists for the other half of the T1.19 DoD — running the flow **once,
  manually, against a real Meta Test Page** after App Review.
- **Why an opt-in rather than a hard block:** the DoD explicitly wants that
  manual run, and a rule with no escape hatch gets worked around rather than
  respected. Requiring it by name means nobody reaches a real platform without
  having typed the words.
- **Also added:** `resetProviderBootstrap()`, so a suite can choose its provider
  deliberately rather than depending on which module happened to latch first.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED

---

## D-048 — Sentry is a seam, not a stub

- **Context:** T1.19's DoD says "Sentry receiving from both apps". `SENTRY_DSN`
  has been in the env schema since T0.1 and no SDK is installed.
- **Decision:** `reportError` in `@orbit/observability` is the contract, with
  `setErrorReporter` as the installation point. No SDK ships. Everything routed
  through it is **logged** — structured, redacted, correlated — whether or not a
  reporter exists.
- **Why not install it:** a reporter that has never delivered to a real project
  is not "receiving", it is a dependency and a claim. Adding an SDK I cannot
  point at a DSN and watch arrive would make the DoD look satisfied while
  leaving the same work to do — and the same reasoning the user accepted for
  email (**D-034**).
- **Turning it on:** add `@sentry/node` and `@sentry/nextjs`, call
  `setErrorReporter` once per deployable at boot. No call site changes.
- **What is guaranteed today:** the property that matters for diagnosis — every
  error is logged with a correlation id that threads browser → API → queue →
  worker → provider. Sentry adds grouping, alerting and release tracking.
- **Date:** 2026-08-12 · **Status:** IMPLEMENTED — **flagged**, since it leaves a
  DoD line partly met.

---

## D-049 — A test run cannot reach hosted infrastructure by accident

- **Context:** `.env` used to name local Docker, so `pnpm test:integration`
  could only ever hit this machine. It now names a hosted Postgres. The
  integration suite creates and deletes organizations.
- **What actually happened:** two runs were started before this was noticed.
  Both were aborted, and both left fixture tenants behind in the hosted
  database — the suite cleans up in `afterAll`, which an aborted run never
  reaches.
- **Decision:** under `NODE_ENV=test`, `loadRootEnv` reads `.env.test` *before*
  `.env`. First file to define a key owns it, so the local overrides win and
  everything not named there still falls through.
- **Why not just export the overrides:** because that is a rule someone has to
  remember, at the exact moment they are least likely to — running the suite is
  routine, and the failure is silent and lands on production data. The guard has
  to be structural or it is not a guard.
- **Why not point `.env` back at Docker:** the app is meant to run against the
  hosted database now. Making the tests safe is the smaller and more honest
  change than making the product local again.
- **Cost:** one more file to keep current when infrastructure changes shape.
  Mitigated by keeping `.env.test` to the keys that must not leak into a test
  run — the connection strings and the bucket — rather than a whole second
  configuration.
- **Date:** 2026-08-13 · **Status:** IMPLEMENTED.

---

## D-050 — Google sign-in, and one source of truth about which provider is live

- **Context:** the server has verified ID tokens and minted session cookies
  since T1.1. Nothing could obtain a token — `apps/web` had no Firebase client
  SDK, and the sign-in form only ever produced `dev:{email}`.
- **What made it urgent:** `selectIdentityProvider()` picks Firebase whenever
  the three `FIREBASE_*` variables are present. Adding real credentials to
  `.env` therefore switched the app to Firebase *locally* and broke sign-in
  entirely — the dev token stopped being accepted and nothing replaced it.
- **Decision:** `firebase` is a dependency of `apps/web`, and
  `GoogleSignInButton` obtains an ID token with `signInWithPopup` and exchanges
  it at the same `POST /api/v1/auth/session` the dev provider uses.
- **The sign-in page asks `selectIdentityProvider()`** rather than checking env
  itself. When a page and an endpoint each decide which provider is live, the
  failure mode is a form that submits successfully into a rejection, with no
  symptom visible from the browser. One function decides; both read it.
- **Google, not email link or password:** it needs no email delivery — which
  is not configured (**D-034**) — and agencies are overwhelmingly on Google
  Workspace. Adding another provider later is a console setting plus a button.
- **We sign out of Firebase after the exchange.** The HttpOnly cookie is the
  session. A Firebase refresh token left in browser storage would be a second,
  longer-lived credential that our revocation path does not reach.
- **The SDK is imported inside the click handler** — `firebase/auth` is large,
  and the sign-in page's job is to be fast for someone who is not signed in.
- **Public config is validated:** the three `NEXT_PUBLIC_FIREBASE_*` values join
  `productionRequired`. Without them the server verifies tokens nobody can
  obtain, and the only symptom is a sign-in page that does nothing.
- **An empty value now means unset.** Because provider selection branches on
  presence, `.env.test` has to *blank* `FIREBASE_*` rather than omit it — an
  omitted key falls through to `.env` and every authenticated integration test
  becomes a 401. `optionalString` in the schema makes `KEY=` parse as undefined,
  which is what everyone already assumes an empty line in a `.env` means.
- **Date:** 2026-08-13 · **Status:** IMPLEMENTED — **blocked externally** until
  Authentication is enabled in the Firebase project and the Google provider
  turned on; the Admin SDK answers `auth/configuration-not-found` until then.

---

## D-051 — The JavaScript SDK returns a code, never a token

- **Context:** Meta's Facebook Login quickstart uses `FB.login`, and its sample
  reads `authResponse.accessToken` in the browser. Adopting that literally would
  put a live credential where any extension or injected script can read it,
  which is the one thing the credential design exists to prevent
  (docs/SECURITY.md §6).
- **The fact that settles it:** the token `FB.login` hands back is a *user*
  token that lasts one to two hours. Publishing happens later, in a worker, with
  no browser present, and needs *Page* tokens. So the server has to run
  `code → long-lived → /me/accounts` either way. Taking the token client-side
  saves no step; it only moves a credential through the browser.
- **Decision:** `FB.login` is called with `response_type: 'code'` and
  `override_default_response_type: true`. The browser receives an authorization
  code, which cannot publish and expires unused, and posts it to
  `POST …/social-accounts/oauth/{platform}/exchange`. That endpoint exchanges it
  server-side with the app secret and stages the discovered accounts exactly as
  the redirect callback does.
- **`redirect_uri` must be empty** on that exchange. The code was not issued
  against a redirect, so Meta has nothing to match it to; sending our callback
  URL fails with a redirect-mismatch error that reads like a misconfigured app.
  A provider test pins this.
- **No signed `state`, deliberately.** The redirect flow needs one because the
  tenant arrives back through a URL a third party sent the user to. This is a
  same-origin `POST` carrying the session cookie: `withAuth` authenticates,
  `assertCan` authorizes the named workspace, and the tenant comes from the
  session. `SameSite=Lax` plus a JSON body means a cross-site page cannot make
  the call.
- **The redirect flow stays.** It is what reconnection uses, and it is the
  fallback when `NEXT_PUBLIC_FACEBOOK_CONFIG_ID` is absent — so this is a choice
  of entry point, not a replacement of the mechanism.
- **Cost:** a third-party script on one page. It is loaded only on the connect
  page, `FB.AppEvents.logPageView()` is not called, and the privacy policy now
  discloses the SDK and its cookies.
- **Date:** 2026-08-13 · **Status:** IMPLEMENTED.

---

## Known residual gaps

**User references are not tenant-enforceable at the database level.** A `Post`
could name a `createdById` belonging to a user with no membership in that
organization. `User` deliberately spans organizations (a person may work for
several agencies), so there is no `(organizationId, id)` key to point at.

Mitigation: services resolve assignees through `OrganizationMembership` before
writing them, and the RBAC layer already refuses to act for a principal without
an active membership. A future hardening option is a trigger asserting
`EXISTS (SELECT 1 FROM "OrganizationMembership" …)`, which would move the check
into the database at the cost of a per-write lookup.

**The health verdict is written in two places — mostly resolved in T1.15.**
`apps/worker/src/health/record.ts` and `apps/web/src/features/social/health.ts`
are still mirrors, because the web app and the worker cannot import each other's
code. But the security-sensitive half moved into `@orbit/notifications`
(**D-036**): recipient resolution, notification copy and channel selection now
have one implementation, and `apps/worker/src/health/recipients.ts` is gone.

What remains duplicated is the status update and the audit row — about 25 lines
each — and the audit row is *meant* to differ, since a web probe names the person
who asked for it and the worker's says `WORKER`. Both files cross-reference each
other at the top, and integration tests assert the same outcomes on each side.

---

## Superseded decisions

*None yet.*
