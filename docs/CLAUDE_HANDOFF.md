# AHN Orbit — Handoff for the next Claude

> **Read this document first, before touching any code.**
> Written 2026-08-12, at the completion of **T1.14**.
> Source of truth is the repository itself; this file points at it and records
> context that is not otherwise written down.
>
> Anything marked **UNKNOWN / NEEDS VERIFICATION** was not established in the
> session that produced this file. Do not assume it either way.

---

## 0. How to use this document

1. Read §0.5 — how the user works, and what they have asked for verbatim.
2. Read §1–§3 to understand what exists.
3. Read §4 (security model) and §5 (decisions) **before** changing anything.
4. Read §8 for the recommended next task.
5. Read §9 for repository conventions that are enforced by lint/CI.
6. Follow §10 before you start editing.

---

## 0.5 How the user works — standing instructions

These were given across the session and have applied to every task. Treat them
as still in force unless the user says otherwise.

**Per task, they expect:**
- Implement the feature **completely** — validation, error handling, loading,
  empty, error and permission-denied states.
- Server-side authorization and tenant isolation everywhere applicable.
- Add/update migrations as needed; add tests for critical functionality.
- Run typecheck, lint, tests **and** the production build; fix before moving on.
- Report per task: what was implemented, files changed, DB changes, APIs, tests,
  and issues needing attention.
- **Do not** move to the next phase until the current one is complete and verified.

**On decisions — this is the important one:**
> "Do not stop and ask for confirmation for minor implementation details. Use
> your best engineering judgment. However, if you encounter a decision that
> materially affects the **database schema, architecture, security model,
> product behavior, or scope**, stop and ask me before proceeding."

In practice: make the safe choice, document it as a `D-xxx`, test it, continue —
and *flag it prominently in the report* rather than burying it. The user has
approved several such changes when asked directly (D-016, D-018).

**Security constraints they stated verbatim** (some in Vietnamese):

- *"Không nên để frontend tự gửi organizationId, userId rồi backend tin vào đó."*
  — Do not let the frontend send `organizationId`/`userId` and have the backend
  trust it.
- *"Tất cả phải bị deny, kể cả khi User A biết chính xác UUID của resource bên B."*
  — All cross-tenant access must be denied even when the exact UUID is known.
- "I want the tenant isolation guarantees to exist at both the application and
  database levels wherever reasonably possible, rather than relying on
  application conventions alone."
- "Keep all Meta/Facebook-specific logic strictly inside the Facebook
  provider/adapter layer."
- "Make sure media validation is based on the actual file bytes rather than
  trusting client-provided MIME types, filenames, or metadata."
- "Keep provider/platform-specific media restrictions in the capability system
  rather than duplicating them in the media layer."
- "Ensure the client never gets to directly control protected fields such as
  organizationId, author/creator identity, status transitions, or
  publishing-related fields."
- "The existing state machine must continue to prevent human users from reaching
  system-only states such as PUBLISHING or PUBLISHED."
- "Keep the Meta Test App validation separate from the core work. Do not make
  [tasks] dependent on live Meta API access."
- "Do not duplicate publishing logic or create a second state machine."

**Style:** they value honest reporting over a clean-looking summary. Bugs found
during a task should be reported as findings, not hidden. Several tasks were
improved because a test or a DB constraint caught a real defect and that was
surfaced rather than quietly patched.

---

## 1. Project overview

### What AHN Orbit is

A **multi-tenant agency social-media management SaaS** for AHN Group.
Comparable to Buffer, but agency-focused: agencies manage many **clients**, each
with **brands**, with an internal→client **approval workflow**, a **client
portal**, scheduling, publishing, analytics and AI assistance.

The original requirement is a 52-section SRS (`srs.docx`, supplied by the user —
**not in the repository**). `docs/00-ANALYSIS.md` is the analysis of it and is
the closest in-repo substitute. Section references throughout the code (`§13`,
`§37`, …) refer to that SRS.

### Repository layout

pnpm monorepo. `pnpm-workspace.yaml` → `apps/*`, `packages/*`.

```
ahn-orbit/
├── apps/
│   ├── web/            Next.js 15 App Router — UI, API routes. PRODUCES queue jobs.
│   └── worker/         Node service — BullMQ workers. The ONLY job consumer.
├── packages/
│   ├── config/         env schema (zod), loadRootEnv
│   ├── core/           domain: errors, enums, state machine, scheduling, timezone,
│   │                   publishing lifecycle, approvals, content hash, clock, tenant
│   ├── observability/  pino logger, redaction, correlation ids
│   ├── db/             Prisma schema + migrations + tenant-scoped client
│   ├── rbac/           permissions, grant matrix, policy engine, transitions
│   ├── auth/           Firebase identity, sessions, principal/tenant resolution
│   ├── providers/      SocialProvider interface, capabilities, registry,
│   │                   credential cipher, Facebook adapter, Mock adapter
│   ├── storage/        S3 client, presigning, byte sniffing/probing
│   ├── queue/          BullMQ: queues, retry policy, locks, rate limits, DLQ
│   └── ui/             design system (tokens + primitives + required states)
├── docs/               ← see §9
└── infra/ecs/          worker task definition + deployment notes
```

### Technology stack

| Concern | Choice |
|---|---|
| Language | TypeScript, **strict**, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` |
| Web | Next.js 15 App Router, React 19, Tailwind 3.4 + CSS-variable tokens |
| DB | PostgreSQL 17 + Prisma 6, UUIDv7 via `uuid_generate_v7()` plpgsql |
| Queue | Redis 7 + BullMQ 5 |
| Identity | Firebase Auth (identity only); **authorization lives in Postgres** |
| Storage | S3-compatible (AWS S3 prod, MinIO local) |
| Tests | Vitest — two projects: unit (`vitest.config.ts`) and integration (`vitest.integration.config.ts`) |
| Lint | ESLint 9 flat config (`eslint.config.mjs`) + Prettier |

### Local infrastructure

`docker-compose.yml` → Postgres 17, Redis 7, MinIO.

```bash
pnpm infra:up            # start Postgres + Redis + MinIO
pnpm db:migrate:deploy   # apply migrations
# MinIO bucket `orbit-media-dev` must exist (tests create it if missing)
```

---

## 2. Completed work

> T1.1 (auth), T1.2 (tenancy), T1.3 (RBAC) and T0.x are also complete but predate
> the detailed notes below. Their outputs are `packages/auth`, `packages/db`,
> `packages/rbac`, `apps/web/src/server/with-auth.ts`.

### Migrations — the whole story

There are **five**, all created during T0.3–T1.4. **No task from T1.5 onward has
needed a migration**, because the schema was designed up front from the SRS.

| Migration | Contents |
|---|---|
| `20260811000000_bootstrap` | extensions, `uuid_generate_v7()` plpgsql |
| `20260811000100_init` | 28 models, 22 enums, indexes |
| `20260811000200_constraints_and_rls` | check constraints, partial indexes, RLS policies |
| `20260811000300_rls_unset_tenant` | fixes `SET LOCAL` reverting to `''` not NULL on pooled connections |
| `20260811000400_composite_tenant_foreign_keys` | 34 composite tenant FKs |

If you believe you need a migration, check the schema first — `PublishingJob`,
`PublishingAttempt`, `QueueSlot`, `Approval`, `Comment`, `Notification` and
`ProductionTask` all already exist with the right shape.

### T1.4 — Organizations, workspaces, brands, invitations

- **Implemented:** org/workspace/brand CRUD, memberships, invitations.
- **Files:** `apps/web/src/features/tenancy/{service,members,invitations,contracts}.ts`.
- **Tests:** `tenancy.integration.test.ts`, `members.integration.test.ts`.
- **Security:** member service refuses self-editing, refuses acting on an owner
  unless you are one, and refuses granting ownership. `role` and
  `organizationRole` were deliberately **removed** from the generic
  `readJsonBody` blocklist — member management exists to set roles; escalation is
  prevented by those service guards, which are stronger than a field blocklist.
  *(User explicitly approved this.)*

### T1.5 — Provider framework & capability system

- **Implemented:** `SocialProvider` interface, `PlatformCapabilities` descriptor
  (zod-validated at registration), provider registry, shared `validateDraft`
  engine, AES-256-GCM credential cipher with AAD binding + key versioning,
  provider error taxonomy, a contract test suite adapters must pass.
- **Files:** `packages/providers/src/{types,capabilities,validation,registry,errors,credential-cipher}.ts`,
  `packages/providers/src/mock/mock-provider.ts`, `packages/providers/src/contract/contract-tests.ts`.
- **Security:** no platform-specific logic outside `packages/providers/{platform}` —
  enforced by an ESLint boundary rule, not reviewer memory.
- **Bug fixed:** `ProviderValidationError` / `ProviderMediaError` had no default
  `userMessage`, so raw Graph messages could reach users. Given safe defaults.

### T1.6 — Facebook OAuth & account connection

- **Implemented:** Facebook adapter (capabilities, client, errors, provider),
  OAuth start/callback, account picker, connect/reconnect.
- **Files:** `packages/providers/src/facebook/*`,
  `apps/web/src/features/social/{service,oauth-state}.ts`.
- **Security:** OAuth `state` is **signed + session-bound + single-use +
  expiring**. No endpoint returns token material to any role, in any form.
- **Architectural decision:** the OAuth callback stages discovered Pages as
  `DISABLED` `SocialAccount` rows so credentials survive between token exchange
  and the user's choice of which Pages to connect. Redis was not yet available
  at that point. A `maintenance` sweep deletes abandoned staged rows after 1h
  (`apps/worker/src/processors/maintenance.ts`).
- **Bugs fixed:** the Facebook test harness matched the first-registered fake
  route so overrides never applied → reversed to last-wins and made the fake
  stateful (`withTimeline()`) so reconciliation could be exercised.

### T1.8 — Media upload & byte verification

- **Implemented:** presigned direct-to-S3 upload, then **server-side byte
  verification**: magic-byte sniffing and header parsing (PNG IHDR, JPEG SOF,
  GIF LSD, WebP VP8/VP8L/VP8X, MP4 box tree).
- **Files:** `packages/storage/src/{sniff,probe,keys,s3,verify}.ts`,
  `apps/web/src/features/media/service.ts`.
- **Security guarantees:**
  - MIME type, filename and metadata from the client are **compared, never
    trusted** — the sniffed type is what is stored and served.
  - S3's byte count is authoritative, not the declared size.
  - Assets stay `PENDING` until verification passes; a non-`READY` asset can
    never be attached to a post.
  - Storage keys are **derived**, never user-supplied; `assertKeyBelongsTo`
    checks tenant ownership before signing.
  - Platform-specific media limits live in the **capability system**, not the
    media layer.
- **Bug fixed:** MP4 `tkhd` offsets were wrong (88/100 instead of 84/96 for
  v0/v1).

### T1.9 — Post model, state machine & composer

- **Implemented:** `createPost`, `getPost`, `listPosts`, `updatePost`,
  `autosavePost` (with conflict detection), `updateVariant`, `transitionPost`,
  `duplicatePost`, `assignPost`, `deletePost`; server-side validation reusing the
  T1.5 engine; the composer UI.
- **Files:** `apps/web/src/features/posts/{service,validation,contracts,route-scope}.ts`,
  `apps/web/src/features/posts/ui/*`, routes under
  `apps/web/app/api/v1/orgs/[orgSlug]/posts/`.
- **DB:** none — `Post`, `PostVariant`, `PostMedia` already existed.
- **Tests:** `posts.integration.test.ts` (36).
- **Security:** authorship always from the session, never the request;
  `PROTECTED_POST_FIELDS` fed to `readJsonBody({ alsoForbid })` so supplying
  `status`/`createdById`/publishing fields is a **logged 400**, not a silent strip.
- **Bug found:** the reopen transitions (`APPROVED → DRAFT`, `SCHEDULED → DRAFT`)
  were unreachable for **every** role — see **D-016**.

### T1.10 — Approval workflow

- **Implemented:** approval gates opened by transitions, `decideApproval`,
  approval queue, per-post history, comments with visibility.
- **Files:** `packages/core/src/approvals.ts`,
  `apps/web/src/features/approvals/{records,service,contracts}.ts`,
  `apps/web/src/features/comments/service.ts`.
- **DB:** none — `Approval` and `Comment` already existed.
- **Tests:** `approvals.integration.test.ts` (39), `packages/core/src/approvals.test.ts` (11).
- **Security:** internal comments are hidden from Clients by **narrowing the
  query**, not by filtering results; an internal comment is a **404** for a
  Client, not a 403. A Client's comment is forced to `CLIENT_VISIBLE` whatever
  they sent. Mentions are filtered through `OrganizationMembership`.
- **Bugs found:** orphaned gates (**D-019**) and a skippable client gate (**D-018**).

### T1.11 — Queue infrastructure & worker service

- **Implemented:** `packages/queue` (queue catalogue with zod payloads, retry
  policy, per-account locks, adaptive token-bucket rate limiting, dead-letter
  set, worker runtime, graceful shutdown) and `apps/worker` (separate process,
  Dockerfile, health/metrics server, maintenance processor).
- **Files:** `packages/queue/src/*`, `apps/worker/src/*`, `infra/ecs/*`.
- **Tests:** 47 unit + 30 integration against real Redis.
- **Verified against the built artifact:** boot, `/health`, `/metrics`, and a
  full SIGTERM drain (`outcome: DRAINED`).
- **Bug fixed:** `Promise.all` over worker closes meant one failing worker
  aborted the whole shutdown, skipping other drains *and* Redis cleanup.
- **Note:** Windows does not deliver real POSIX signals; SIGTERM was verified by
  emitting the signal into the built artifact, not via `kill`.

### T1.12 — Scheduling & calendar

- **Implemented:** IANA timezone arithmetic on `Intl` (no library), scheduling
  domain rules, `schedulePost`/`reschedulePost`/`unschedulePost`, calendar
  windowing, the 30s sweep, month + list calendar UI with drag-to-reschedule.
- **Files:** `packages/core/src/{timezone,scheduling}.ts`,
  `apps/web/src/features/scheduling/*`,
  `apps/worker/src/processors/{scheduler,scheduler-job}.ts`.
- **Tests:** 65 unit (both DST transitions in `Europe/London`,
  `America/New_York` *on its own date*, `Australia/Sydney` for the inverted
  hemisphere, `Asia/Ho_Chi_Minh` as the no-DST control) + 44 integration.
- **Bug fixed (important):** overlap detection probed only *forward* from its
  first guess, so it found the autumn-back overlap in New York but **missed it
  in London**. Rewritten to enumerate every instant matching the wall time and
  classify by count. See **D-024**.

### T1.13 — Publishing engine (4-layer idempotency)

- **Implemented:** the exactly-once publishing engine.
- **Files:** `packages/core/src/publishing.ts`,
  `apps/worker/src/publishing/{claim,attempts,rollup,subject,engine}.ts`,
  `apps/worker/src/processors/publish.ts`,
  `apps/web/src/features/publishing/service.ts`.
- **Tests:** 22 unit + 32 integration against real Postgres/Redis and the mock's
  fault injection — `TIMEOUT_THEN_PUBLISHED`, `TIMEOUT_NOT_PUBLISHED`, three
  concurrent workers on one variant, worker-crash recovery, rate-limit deferral,
  auth-error non-retry.
- **Bug found:** the *post* never moved to `PUBLISHING`, so the rollup attempted
  `SCHEDULED → PUBLISHED`, which does not exist. The state machine refused it and
  six tests failed. See **D-026**.

### T1.14 — Publishing logs & failure handling

- **Implemented:** `presentFailure` (every `ErrorCode` → summary + recommended
  action, exhaustive by type), job list (cursor-paginated, filterable), job
  detail with attempt chain, needs-review queue, per-job retry, and **resolution
  of a parked publish** — the gap T1.13 deliberately left.
- **Files:** `packages/core/src/failure-presentation.ts`,
  `apps/web/src/features/publishing/{logs,resolve,contracts}.ts`,
  `apps/web/src/features/publishing/ui/*`,
  `apps/web/app/(app)/orgs/[orgSlug]/publishing/page.tsx`.
- **Tests:** 12 unit + 34 integration.
- **Bug found:** resolution could mark a variant `PUBLISHED` without an external
  post id; the DB check constraint `PostVariant_published_requires_external_id`
  rejected it. See **D-030**.

---

## 3. Current state

### Verification status (as of 2026-08-15, end of the production completion pass)

| Check | Command | Result |
|---|---|---|
| Format | `pnpm format:check` | ✅ clean |
| Lint | `pnpm lint` | ✅ 0 problems |
| Typecheck | `pnpm typecheck` | ✅ 0 errors |
| Unit tests | `pnpm test` | ✅ **797 passed** (39 files) |
| Integration tests | `pnpm test:integration` | ✅ **640 passed** (32 files) |
| E2E | `pnpm test:e2e` | ✅ **19 passed** (1 file) |
| Build | `SKIP_ENV_VALIDATION=true pnpm build` | ✅ web + worker |

**`pnpm build` requires `SKIP_ENV_VALIDATION=true`** unless real env vars are in
the shell. `next build` sets `NODE_ENV=production`, and `loadRootEnv()`
deliberately does not read `.env` in production. `SKIP_ENV_VALIDATION` is the
designed seam for exactly this (see `packages/config/src/env.ts`).

### Production-ready

- Tenant isolation (two layers), RBAC, auth/session.
- Media upload + byte verification.
- Post model, state machine, composer, approvals.
- Scheduling incl. DST correctness; calendar.
- Queue + worker + publishing engine with all four idempotency layers.
- Publishing logs and failure handling.

### Mocked / not externally validated

- **No real publish has ever happened.** Everything is tested against
  `MockProvider`. The Facebook adapter is written and unit-tested but has not
  published to a real Page.
- Facebook credentials *are* configured in the local `.env`
  (`FACEBOOK_APP_ID`/`FACEBOOK_APP_SECRET` are set), but **Meta App Review has
  not started** — see §6.
- `MockProvider` is registered only when Facebook is unconfigured, and the
  registry **refuses it in production** (`developmentOnly: true`).
- Analytics, AI, billing, notifications, client portal, admin: **not built**.

---

## 4. Security model — do not break these

Each item below is load-bearing and has tests. If you find yourself weakening
one, stop and flag it (§10).

### 4.1 Multi-tenant isolation — two independent layers

1. **Tenant-scoped Prisma client** (`packages/db/src/tenant-scope.ts`) — the
   primary control. Constructible **only** from a `TenantContext`. It bans
   `findUnique`/`findUniqueOrThrow`/`upsert` on tenant models (they bypass the
   filter) and merges the tenant filter as a **sibling key**, not an `AND`
   wrapper, because Prisma needs a unique field at top level for
   `update`/`delete`.
2. **Postgres RLS** (migrations `..000200`, `..000300`) — the backstop, tested
   as the non-owner `orbit_app` role. `..000300` fixed a real bug: `SET LOCAL`
   reverts to `''`, not NULL, on reused pooled connections, so the policy uses
   `NULLIF(current_setting(...), '')::uuid`.

### 4.2 Composite tenant foreign keys

34 constraints of the form `(organizationId, childId) → Parent(organizationId, id)`
(migration `..000400`). Cross-tenant references are rejected **by the database**.
Optional refs use `NoAction`, not `SetNull`, because `SetNull` would null a
NOT-NULL `organizationId`.

**Residual gap (documented):** `User` references (`createdById`, `assignedToId`,
`uploadedById`) cannot be composite — a user legitimately spans organizations.
Mitigated by resolving assignees through `OrganizationMembership` before writing.

### 4.3 RBAC

- 58 permissions, declarative grant matrix (`packages/rbac/src/matrix.ts`),
  typed denial reasons.
- `withAuth` enforces a fixed order: **authenticate → resolve user → resolve
  tenant (from the URL) → authorize → handler**. A handler cannot skip a step
  because it receives nothing usable until every step has run.
- Cross-tenant returns **404, never 403** — a 403 would confirm existence.
- Frontend permission checks only *hide* controls; the server always re-decides.

### 4.4 Protected request fields

`readJsonBody` refuses a body carrying server-derived fields and **logs a
security event** rather than silently stripping:

- Global: `organizationId`, `userId`, `actorUserId`, `isPlatformAdmin`, `membershipStatus`.
- Per-route via `alsoForbid`: `PROTECTED_POST_FIELDS`, `PROTECTED_APPROVAL_FIELDS`,
  `PROTECTED_COMMENT_FIELDS`, `PROTECTED_PUBLISHING_FIELDS`.

### 4.5 Credential encryption

AES-256-GCM with **AAD binding** to `{ organizationId, socialAccountId }` and key
versioning. A credential row moved between tenants fails to open. Decrypted only
in memory, inside the provider/worker layer. Never logged, never serialised into
a response.

### 4.6 OAuth CSRF

`state` is signed, session-bound, single-use and expiring
(`apps/web/src/features/social/oauth-state.ts`).

### 4.7 Media verification

See §2/T1.8. The short version: **bytes decide**, not the client.

### 4.8 Worker tenant derivation (D-021)

A job payload's `organizationId` is a **checked assertion, never a source of
truth**. Every processor resolves its subject row by primary key and derives the
tenant from *that row*; a mismatch is a `TenantIsolationError` and a
`securityEvent`. `resolveJobTenant` (`packages/queue/src/tenant.ts`) is the only
sanctioned path.

### 4.9 Queue security

- Payloads carry **identifiers only** — no post bodies (a job queued before an
  edit must not publish the stale copy), no credentials, no signed URLs.
- Payloads are zod-parsed on **both** sides; an unparseable payload is
  dead-lettered without reaching provider code.
- The web app may only **produce**. Three guards: module split, ESLint rule on
  `@orbit/queue` consumer imports, and `assertWorkerProcess()` requiring
  `ORBIT_ROLE=worker` at runtime (**D-022**).

### 4.10 Publishing idempotency — four layers

1. **Deterministic job id** — `publishIdempotencyKey(variant, scheduledFor,
   contentHash)` is used as the BullMQ job id; a duplicate add is dropped.
2. **Atomic claim in Postgres** — one conditional
   `UPDATE … WHERE status='SCHEDULED'`. **This is the real guarantee.** Exactly
   one concurrent worker wins; the rest exit without calling the provider. It
   also doubles as the cancellation check.
3. **Redis lock per account** — advisory only. Losing it cannot cause a
   duplicate, because layer 2 already prevented one.
4. **Reconciliation before retry** — a `PublishingAttempt` row is written
   `IN_FLIGHT` **before** the provider call. That ordering is the whole point: if
   the worker dies mid-call, the row is the only evidence a call may have landed.

### 4.11 Reconciliation behaviour (D-027) — the rule with teeth

**An ambiguous outcome is never retried.**

- Reconciliation `FOUND` → treat as published, adopt the external id, record the
  attempt as `RECONCILED` (not `SUCCEEDED`).
- `NOT_FOUND` → confirmed absent, safe to retry.
- `INCONCLUSIVE`, reconcile threw, or the provider is not `reconcilable` →
  variant parks in `NEEDS_REVIEW` and **nothing automated touches it again**.

Matching is on `contentHash` within ±10 min of the attempt. Tested: an unrelated
post on the same Page is **not** adopted.

### 4.12 Audit and security events

- `audit()` writes inside the same transaction as the change it records.
- The audit table is append-only at the grant level (no UPDATE/DELETE for
  `orbit_app`).
- `securityEvent: true` log lines: cross-tenant attempts, protected-field
  probes, job tenant mismatches, on-behalf-of approvals, human resolution of a
  parked publish.

---

## 5. Decisions (`docs/DECISIONS.md`)

D-001 … D-015 cover foundational architecture (monorepo, ECS workers, Firebase
identity, tenant isolation strategy, `PostVariant` as the publishing unit,
four-layer idempotency, DB-sweep scheduling, media verification, composite FKs).
**Read them in the file.** The ones made during this session:

| # | Decision | Depends on it / risk if changed |
|---|---|---|
| **D-016** | The edit lock applies to **content edits**, not transitions. `ResourceScope.intent: 'EDIT' \| 'TRANSITION'`; `requiresEditable` is skipped only for `TRANSITION`, and only after the state machine confirmed the transition exists. | **Security/RBAC.** Reverting makes `APPROVED → DRAFT` and `SCHEDULED → DRAFT` unreachable for every role (that was the bug). Widening it would let content be edited after approval. |
| **D-017** | Approvals **ride** the post state machine. `decideApproval` computes the target status, then calls `transitionPost`; the decision row is stamped inside that transaction via `onTransition`. | **State machine.** Changing it risks two places deciding where a post goes. |
| **D-018** | `Post.approvalRequired` (default **true**) means *client* approval is required, and `INTERNAL_REVIEW → APPROVED` is a **409** while it applies. | **Product behaviour.** Default posture is "the client must approve". User approved this explicitly. |
| **D-019** | Leaving a review status closes the gate, independently of `voidsApprovals`. `onTransition` runs **before** the gate bookkeeping so a decision's own record is not cancelled. | **Ordering is load-bearing.** Reversing it breaks `decideApproval`. |
| **D-020** | Retry policy lives in the worker, not BullMQ's `attempts`. Jobs are added with `attempts: 1`; `decideRetry` re-enqueues. | **Publishing.** BullMQ's counter cannot express a rate limit that doesn't consume an attempt, nor a timeout that must not retry. |
| **D-021** | A job's tenant is derived from its **subject row**, never its payload. | **Security.** See §4.8. |
| **D-022** | The web app produces; only the worker consumes. Three guards. | **Architecture.** |
| **D-023** | DST: a **user-picked** time in a spring-forward gap is **rejected**; a **recurring queue slot** shifts forward. Overlaps take the **earlier** instant. | **Product behaviour.** |
| **D-024** | Timezone arithmetic uses `Intl`, not a library. Node's ICU is the tz database. | Changing to a library reintroduces stale-tz-data risk. |
| **D-025** | The scheduler sweep gets its own `scheduler` queue, `every: 30_000`. | Sharing `maintenance` (concurrency 1) would delay the sweep. |
| **D-026** | The **post** travels through `PUBLISHING` too. `markPostPublishing` moves `SCHEDULED → PUBLISHING` when the first variant is claimed. | **State machine.** Without it the rollup has no legal target. |
| **D-027** | An unresolved publish **parks**; it never retries. | **Publishing guarantee.** The single most important behavioural rule. |
| **D-028** | "Publish now" is scheduling for the present — same key, same job row. | Two doors into the engine would be two chances to get idempotency wrong. |
| **D-029** | A parked publish is resolved by a **person**, on the record. Three answers, all requiring a reason, all audited. "It did not publish" hands back to the engine. Permission reused: `post:retry_failed`. | **Product behaviour + RBAC.** |
| **D-030** | Confirming a publish **requires** the external post id. | Enforced by DB constraint too. Reconciliation and analytics both need the id. |

### Open / unresolved

- **Q5 (Meta App Review)** — see §6. The only P0 question still open.
- **O1** (approve on a client's behalf) — implemented per the documented default
  (allowed, audited, mandatory reason). **Not explicitly confirmed by the user.**
- **O2** (clients uploading assets) — schema field exists
  (`Workspace.clientUploadsEnabled`), behaviour not built.
- **O3, O4, O5** — see `docs/RBAC.md` §8. Defaults implemented; not confirmed.
- **A post that settled to `PARTIALLY_PUBLISHED` is not promoted to `PUBLISHED`**
  when its last parked account resolves — no such transition exists. Flagged to
  the user at the end of T1.14; **no answer yet**.

---

## 6. Current blockers

### Meta App Review + Business Verification — **NOT STARTED**

This is the **critical path to launch** and has been flagged at the end of every
task. It is wall-clock time that cannot be compressed later: realistically
**2–4 weeks including one revision round** (`docs/SOCIAL_PROVIDERS.md` §2 note 1).

**Permissions required for publishing to real client Pages:**
`pages_manage_posts`, `pages_read_engagement`, `pages_show_list`
(plus `pages_manage_engagement` for comments) — **all gated behind full App
Review and Business Verification**.

**What can be validated now, with a Meta Test App:**
- OAuth start/callback and the account picker.
- Capability descriptors against the real Graph API version.
- Publishing to a Page owned by the developer/test users.
- The Facebook adapter's error mapping and reconciliation shape.

**What cannot be validated until approval:**
- Publishing to a **client's** Page.
- Anything requiring the reviewed permissions on non-test accounts.
- Real rate-limit header behaviour at volume.

The user asked (during T1.9) that Meta Test App validation be kept **separate**
from feature work and that no task depend on live Meta access. That has been
honoured — everything is tested against `MockProvider`.

---

## 7. Remaining roadmap

**Phase 1 (MVP publishing) is complete** — T1.1 through T1.19, plus Instagram
alongside Facebook, and a live Facebook publish verified end to end against a
real Page.

**Phase 2 (agency operations) is complete** as of 2026-08-14:

| Shipped | Where | Tests |
|---|---|---|
| Production tasks — stages, assignee, blocking | `apps/web/src/features/tasks/` | 14 integration |
| Post-level assignment UI | `features/posts/ui/assignee-select.tsx` | covered by posts suite |
| Agency comment thread (internal vs client-visible) | `features/comments/ui/comment-thread.tsx` | covered by comments suite |
| Members list + invitations UI + `/accept-invitation` | `features/tenancy/ui/`, `app/(app)/accept-invitation/` | covered by members suite |
| Media library — browse, search, filter, previews | `features/media/`, `app/(app)/orgs/[orgSlug]/media/` | covered by media suite |
| Activity feed + per-post history | `features/activity/` | 5 integration |

New decisions from this phase: **D-052** (a task holds a post, never moves one),
**D-053** (the activity feed is read-only, scoped by role, keyset-paged),
**D-054** (library previews are signed, inline, and deliberately not
`next/image`).

### Still deferred

- ~~`/posts/{id}/preview` endpoint~~ — **shipped as a client-side sketch
  instead** (**D-084**). A server endpoint would have had to hold platform
  presentation facts next to the capability descriptor, which is the confusion
  the preview is built to avoid. `features/posts/ui/preview.tsx` renders it from
  what is already on screen; `preview-shape.ts` is pure and tested.
- Drag-to-reorder on composer media (T1.9).
- ~~Queue-slot editor UI~~ — **shipped** (**D-083**). Service, two API routes, a
  week-laid-out editor at
  `/orgs/{slug}/settings/workspaces/{id}/queue`, 23 integration tests.
- Media **folders**: `MediaAsset.folderId` exists in the schema and the library
  ignores it. Filtering is by brand, type, filename, and tag.
- Attaching an existing library asset to a post from the library page. Upload
  from the composer works; "reuse this one" is still a composer-side upload.
- Infinite scroll on the activity feed. The service returns `nextCursor` and
  the page renders the first 50; nothing consumes the cursor yet.

---

## 8. Production completion pass (2026-08-15)

A product-level pass over the whole repository rather than a feature. What
changed, and why it was worth changing:

| Area | Change |
|---|---|
| Design system | `Dialog`, `ConfirmDialog`, `Toast`, `Table`, `Stat`, `Alert`, `Breadcrumbs`, `Section` added to `@orbit/ui`. Pages had been inventing these one at a time. |
| Navigation | Derived from the permission matrix, grouped, with an active state and a real mobile disclosure (**D-069**). |
| Dashboard | Composed by role — "Your work" leads for anyone without the agency-wide picture (**D-070**). |
| Team | Role editing, member removal with confirmation, and **pending invitations** — which were previously invisible. |
| Media | Attach from the library instead of re-uploading (**D-072**). |
| Activity | `Load more` consumes the `nextCursor` the service always returned. |
| RBAC | `canSomewhere()` for menus, and the Brand Brain moved onto `brand_voice:*` (**D-073**). |
| CI | The production build and the E2E suite now run. |

### Media folders and email (2026-08-16)

| Area | Change |
|---|---|
| Email notifications | The notification row is the outbox; four types earn an email (**D-080**) |
| Media folders | Create, rename, delete-without-deleting, file assets, breadcrumb (**D-081**) |
| Calendar week view | Times visible per day, shared reschedule path with month (**D-082**) |

Both used schema that already existed — **no migrations**.

### Second pass (same day)

| Area | Change |
|---|---|
| AI rate limiting | Two token buckets, checked before the credit check — a loop can no longer burn a month's allowance in seconds (**D-075**) |
| MetricStrip | Metric priority per platform, replacing "first four the JSON returned" (**D-074**) |
| Content Ideas | Phase 4 P2: CRUD, search, accept/dismiss, planning window, convert-to-draft (**D-076**), **and the board UI** (**D-078**) |
| AI cost visibility | `creditsRemaining` returned by every generation, so a Content Creator sees it without `ai:view_usage` (**D-077**) |

### Two real bugs this pass found

1. **Navigation would have hidden itself from Account Managers.** `can()`
   denies a workspace-scoped grant asked without a workspace, so a menu built
   on it loses Analytics, Media, Approvals and Activity for the role those
   pages exist for (**D-069**).
2. **Brand Brain was guarded by the wrong permission.** `brand_voice:read` is
   granted to Content Creators and Approvers precisely so they can write
   on-brand without editing the definition; `brand:update` moved that line
   (**D-073**).

---

## 9. Next task — the rest of Phase 4 P2

**Content Ideas shipped** (service, three API routes, 13 integration tests) with
a `planningWindow` that puts dated ideas and scheduled posts on one timeline.

**Ideas UI shipped** — board, filters in the URL, create, agree/drop, and
convert-to-draft with a confirmation (**D-078**). Reachable from **Work → Ideas**.

**Repurposing shipped** — `adaptForPlatform` on the provider interface, Gemini
and mock implementations, `POST /ai/repurpose`, and two buttons in the composer.
Constraints come from the target's capability descriptor (**D-079**).

**Still not built:**
- **Performance-informed suggestions.** Needs analytics *and* a careful
  separation between observed figures and model interpretation — the SRS is
  explicit that AI guesses must never be presented as analytics.
- **The AI queue.** Still not justified: every operation implemented so far is
  short and somebody is waiting for it. Bulk repurposing would be the first
  thing that changes that.

**T3.1 → T3.4 are complete.** Analytics ingest on a cadence, are read through
three endpoints, and are shown on an org-level page and on each post.

| Shipped | Where | Tests |
|---|---|---|
| Ingestion — post and account | `apps/worker/src/analytics/ingest.ts` | 12 integration |
| Sweep + hourly schedule | `apps/worker/src/analytics/sweep.ts` | (same suite) |
| Read services + 3 API routes | `apps/web/src/features/analytics/` | 11 integration |
| Analytics page + per-post results | `app/(app)/orgs/[orgSlug]/analytics/`, post page | typecheck + build |
| Instagram account metrics, corrected | `packages/providers/src/instagram/` | 4 unit |

New decisions: **D-057** (an unavailable metric is never a zero; a partial sum
is never a total), **D-058** (polls on a cadence, never on a page load),
**D-059** (Instagram account insights are a different API from media insights).

**No migration and no new permission were needed** — `PostAnalytics`,
`AnalyticsSnapshot`, `analytics:read` and the `analytics` queue all predated
this work.

### T3.5 shipped

`Report` model (migration `20260814010000_report`), a `reports` queue, a CSV
renderer on the worker, three API routes, and a panel on the analytics page.
Decisions: **D-060** (signed URL, never a storage key), **D-061** (the job names
a row and carries no parameters), **D-062** (CSV now; PDF is a dependency
decision).

No new permissions — `report:generate` and `report:export` already existed and
are used as the separation they were written to be: generating is one right,
handing the file to somebody is another.

### T4.1 → T4.5 shipped — Phase 4 P1 (AI)

| Shipped | Where | Tests |
|---|---|---|
| Brand Brain — storage, API, brand page | `features/brand-voice/`, `app/(app)/orgs/[orgSlug]/brands/[brandId]/` | covered below |
| `packages/ai` — interface, Gemini over `fetch`, mock, prompt assembler | `packages/ai/` | 30 unit |
| Metering + credit ceiling | `features/ai/service.ts` | 15 integration |
| `caption` · `rewrite` · `hashtags` · `usage` endpoints | `app/api/v1/orgs/[orgSlug]/ai/` | (same suite) |
| Writing assistant in the composer | `features/ai/ui/ai-assist.tsx` | typecheck + build |

Decisions: **D-065** (untrusted text is fenced, and the fence cannot be closed
from inside), **D-066** (one request is one credit; a failed call still counts),
**D-067** (AI suggests, a person acts; banned terms warn and never block),
**D-068** (Gemini over `fetch`; mock when there is no key).

**No migration and no new permission were needed.** `BrandVoice`, `AIUsage`,
`ai:generate` and `ai:view_usage` all predated this work.

**Configuration:** `GEMINI_API_KEY` is optional. Absent, the mock answers
locally and production refuses at first use. `GEMINI_MODEL` defaults to
`gemini-2.0-flash`.

### Outstanding from this phase

- **PDF export.** See D-062: a dependency choice, not a formatting one.
- **`MetricStrip` metric prioritisation.** Held; see below.
- **Phase 4 P2, untouched by design:** content ideas and planning, repurposing,
  and performance-informed suggestions. `ContentIdea` exists in the schema with
  `Post.sourceIdeaId` wired, and `docs/API.md` §2.10 specifies `/ai/ideas`,
  `/ai/repurpose` and `/ai/generations/{id}`. None are implemented. A long
  generation is the case the `ai` queue was described for in
  `docs/ARCHITECTURE.md` §7 — **that queue does not exist yet**, deliberately,
  because P1 runs synchronously in the request and adding a queue nobody
  consumes is a catalogue entry and a doc to keep true for no gain.
- **`AIProvider` implements three of §7's methods.** `changeTone`, `generateCTA`,
  `adaptForPlatform`, `generateIdeas`, `repurposeContent` and
  `analyzeHistoricalPerformance` are absent rather than stubbed, so nothing can
  call a method that quietly returns nothing. (`tone` is reachable today as a
  `rewrite` mode.)
- **The trial AI allowance changed from 500 to 50 credits/month.** It governs
  organizations created *after* the change only — an existing subscription
  carries its own `limits` on the row, so nobody on a trial lost credits.

### T3.6 shipped — retention and cleanup

`apps/worker/src/maintenance/retention.ts`, wired to the `retention`
maintenance task and scheduled nightly at 03:20. Removes `PostAnalytics` and
`AnalyticsSnapshot` beyond a 13-month window, and `Report` rows past
`expiresAt` together with their S3 objects. Decisions **D-063** (per-tenant
deletes; every boundary rounds toward keeping) and **D-064** (object before
row).

It never touches `Post`, `PostVariant`, `PublishingJob`, `PublishingAttempt` or
`AuditLog`, and there is a test for each of those that matters.
- **`MetricStrip` metric prioritisation.** It shows the first four metrics of
  whatever the platform returned, in insertion order — behaviour left unchanged
  on purpose. Which four matter per platform is a product decision, and picking
  them silently would bake an opinion into what every client sees first.

---

## 9b. Phase 3 background — verified provider facts

Per `docs/00-ANALYSIS.md` §302-306 the phases are: 0 Foundation, 1 MVP
publishing, 2 Agency operations, **3 Intelligence**, 4 AI. Phase 3 is analytics
and reporting: pulling post-level insights back from the providers, rolling
them up, and putting them in front of both the agency and the client.

**The API-version question is settled.** `FACEBOOK_GRAPH_VERSION` now defaults
to `v25.0`, and the v22→v25 changelogs were audited rather than assumed: nothing
in that range touches this product's publishing path (**D-056**). The metric
work that *does* matter was done up front —

- Instagram's play-and-impression family (`impressions`, `plays`,
  `clips_replays_count`, `ig_reels_aggregated_all_plays_count`) was replaced by
  a single **`views`** on 2025-04-21. `views` is now the claimed metric.
- The v26.0 deprecation wave announced in the v25.0 changelog is already listed
  in the Facebook descriptor's `DEPRECATED_METRICS`, before it breaks.

So the metric names in `packages/providers/src/*/capabilities.ts` are the
starting point, and `docs/SOCIAL_PROVIDERS.md` §3 is the reference.

**`analytics-rollup` already exists as a declared maintenance task** that logs
"not yet implemented" (`apps/worker/src/processors/maintenance.ts`). It is the
intended home for the aggregation, and the queue plumbing around it is done.

What already exists and must not be reimplemented: the capability descriptor
system (which is where per-provider metric support belongs), the audit trail
(now readable — see §7), and the `PostVariant` rows that carry `externalPostId`,
which is the join key any insights fetch needs.

---

## 10. Repository knowledge you need before editing

### Package boundaries (enforced by `eslint.config.mjs`)

- `apps/web` and `packages/core` may **not** import `bullmq`'s `Worker`, nor
  `@orbit/queue`'s `startWorker` / `blockingConnection` / `installShutdownHandlers`.
- `apps/web` and `packages/core` may **not** import `@prisma/client` directly —
  use `@orbit/db`. Only `packages/db` may construct a `PrismaClient`.
- Nothing outside `packages/providers/{platform}` may contain platform-specific
  logic. `@orbit/providers/*/` subpath imports are banned outside the package.
- `apps/web` and `packages/ui` are **bundler-resolved**: relative imports must be
  **extensionless** (no `.js`). Everything else is NodeNext and **requires** `.js`.
  Both are lint-enforced; the `.js` one typechecks but fails `next build`.
- `new Date()` with no arguments is **banned** — use `clock.now()` from
  `@orbit/core` (`packages/core/src/clock.ts`) so time is injectable.

### Web / worker separation

- `apps/web` **produces** jobs only.
- `apps/worker` is the only consumer. Its entry is
  `apps/worker/src/index.ts` — an ESM shim that sets `ORBIT_ROLE` and
  `ORBIT_SERVICE` **before** dynamically importing `main.ts`. This ordering is
  required: ESM hoists imports, and pino fixes its base fields at module
  evaluation.

### Database conventions

- UUIDv7 primary keys via `dbgenerated("uuid_generate_v7()")`.
- Every tenant model has `@@unique([organizationId, id])` to support composite FKs.
- Soft delete via `deletedAt` on most models.
- `Timestamptz(3)` everywhere; **all timestamps stored UTC**.
- Check constraints are real and load-bearing — they have caught application
  bugs twice (see T1.13/T1.14). Examples:
  `Post_published_requires_timestamp`, `MediaAsset_rejected_requires_reason`,
  `PostVariant_published_requires_external_id`,
  `PostVariant_scheduled_requires_scheduledFor`.
- Migrations are SQL files under `packages/db/prisma/migrations/`. **Write them
  without a BOM** — PowerShell's `Out-File`/`Set-Content -Encoding utf8` adds one
  and Postgres fails with `syntax error at or near "﻿"`. This has bitten twice.

### Testing conventions

- **Unit** tests (`*.test.ts`) must run with **no infrastructure**.
- **Integration** tests (`*.integration.test.ts`) require `pnpm infra:up` and
  applied migrations. They run with `fileParallelism: false` (shared database).
- Integration tests use `setClock(fixedClock(NOW))` for determinism — but note
  the **Redis token bucket refills from real `Date.now()`** deliberately, so
  drain it with `Date.now()`, not the fixed clock.
- Each test file uses its own UUID prefix for tenants and cleans up in
  `beforeEach`/`afterAll`.
- The `@` alias maps to `apps/web/src` in both vitest configs.

### Environment variables (`packages/config/src/env.ts`)

Required: `DATABASE_URL`, `REDIS_URL`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, `CREDENTIAL_ENCRYPTION_KEY` (base64, 32 bytes),
`STATE_SIGNING_SECRET` (base64, 32 bytes).

Optional/defaulted: `NODE_ENV`, `APP_ENV`, `APP_URL`, `LOG_LEVEL`, `DIRECT_URL`,
`WORKER_HEALTH_PORT` (3100), `S3_REGION`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`,
`S3_PUBLIC_BASE_URL`, `CREDENTIAL_ENCRYPTION_KEY_VERSION`,
`FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `FACEBOOK_GRAPH_VERSION`,
`FACEBOOK_WEBHOOK_VERIFY_TOKEN`, `FIREBASE_*`, `GEMINI_*`, `STRIPE_*`,
`RESEND_API_KEY`, `EMAIL_FROM`, `SENTRY_DSN`.

Also read directly from `process.env` (not in the schema): `ORBIT_ROLE`,
`ORBIT_SERVICE`, `SKIP_ENV_VALIDATION`.

`loadRootEnv()` walks up to `pnpm-workspace.yaml`, never overwrites an already-set
variable, and **skips entirely in production**.

### Commands

```bash
pnpm infra:up                              # Postgres + Redis + MinIO
pnpm db:migrate:deploy                     # apply migrations
pnpm dev                                   # web
pnpm dev:worker                            # worker
pnpm verify                                # format:check + lint + typecheck + test
pnpm test:integration                      # needs infra up
SKIP_ENV_VALIDATION=true pnpm build        # web + worker
```

**Windows note:** this repo has been developed on Windows. PowerShell and Git
Bash are both available. Avoid `Out-File`/`Set-Content` for source files (BOM).
Heredocs in Git Bash work; watch for apostrophes breaking quoting in long chains.

### Important docs

| File | What it is |
|---|---|
| `docs/00-ANALYSIS.md` | SRS analysis, assumptions **C1–C11**, open questions **Q1–Q12** |
| `docs/ARCHITECTURE.md` | Topology, queues (§5.1), **idempotency strategy (§5.2)**, providers (§6) |
| `docs/DATABASE.md` | Schema rationale |
| `docs/RBAC.md` | Permission matrix per role, transition rights (§5), open questions **O1–O5** |
| `docs/API.md` | Endpoint surface + error envelope; marks what is implemented |
| `docs/SOCIAL_PROVIDERS.md` | Platform capabilities, Meta specifics, health (§4) |
| `docs/BUILD-PLAN.md` | Task breakdown, per-task DoD, **✅ DONE** status lines |
| `docs/DECISIONS.md` | **D-001 … D-030** + known residual gaps |
| `docs/PROVIDER_GUIDE.md` | How to write a new adapter |

### Patterns that must be followed

- Every service function takes `ctx: TenantContext` first and uses
  `withTenant(ctx, db => …)`.
- Every route uses `withAuth({ permission, resource, name }, handler)`.
- Route `resource` resolvers exist as shared helpers
  (`features/posts/route-scope.ts`) — reuse them.
- Every mutation writes an `audit()` row in the same transaction.
- Every new endpoint ships with a **cross-tenant 404 test** in the same PR
  (`docs/BUILD-PLAN.md` §5 working agreements).
- Every feature ships loading / empty / error / permission-denied states
  (`@orbit/ui` exports `Loading`, `Empty`, `ErrorState`, `PermissionDenied`,
  `Offline`).
- Status/tone maps in UI are typed as **total** `Record<Status, …>` so a new
  status is a compile error until someone decides how to show it.

---

## 11. Handoff instructions for the next Claude

1. **Read this document first**, then `docs/DECISIONS.md`, `docs/RBAC.md`,
   `docs/ARCHITECTURE.md` §5, and `docs/BUILD-PLAN.md` for your task.
2. **Do not redo completed work.** T1.1–T1.6 and T1.8–T1.14 are done, tested and
   verified. Check the **✅ DONE** status lines in `docs/BUILD-PLAN.md`.
3. **Inspect the repository before coding.** Much of what a task appears to need
   already exists — T1.7's health check, reconnect path, queue and payload
   schema are all present. Grep before you write.
4. **Preserve the security guarantees in §4.** They each have tests; if a test
   in that area starts failing, assume you broke a guarantee, not that the test
   is wrong.
5. **Stop and flag** — do not silently change — anything that materially affects:
   the security model, RBAC/permission matrix, the post state machine, tenant
   isolation, database structure, publishing/idempotency semantics, or product
   behaviour. The user has been explicit about this and has approved several such
   changes when asked (D-016, D-018). Ask.
6. **Reuse, don't duplicate.** No second state machine, no second publishing
   path, no second validation engine. If you need a decision made in two places,
   share the pure function.
7. **After implementation, run all of it:**
   ```bash
   pnpm format && pnpm lint && pnpm typecheck
   pnpm test && pnpm test:integration
   SKIP_ENV_VALIDATION=true pnpm build
   ```
   Everything must be green before you report the task complete.
8. **Record decisions.** Append to `docs/DECISIONS.md` in the same change that
   makes them (working agreement §5.5), and add a **✅ DONE** status line to the
   task in `docs/BUILD-PLAN.md`.
9. **Report honestly.** If something is blocked, partly done, or untested, say
   so plainly. The user has consistently valued that over a clean-looking summary.
10. **Keep flagging Meta App Review.** It is the launch-critical external
    dependency and it has not started.
