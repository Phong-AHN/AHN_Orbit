# AHN Orbit — MVP Prioritisation & Phase 1 Build Plan

> Status: **proposed**. Answers SRS §40 (P0/P1/P2 classification of every feature) and §46.J
> (Phase 1 broken into small tasks). Last updated: 2026-08-11.
>
> **Nothing here starts until the P0 questions in `00-ANALYSIS.md` §D are answered** — except
> **T0.0 (Meta App Review)**, which must start immediately regardless, because it is wall-clock time
> we cannot compress later.

---

## 1. Feature classification (§40)

`P0` = required for MVP · `P1` = important after MVP · `P2` = future enhancement

### Authentication & security (§6)

| Feature | Pri | Note |
|---|:--:|---|
| Email/password, verification, reset (Firebase) | **P0** | Delegated to Firebase |
| Google sign-in | **P0** | Firebase provider; cheap |
| Session cookie + server-side verification | **P0** | Foundation |
| CSRF, XSS hardening, secure cookies, input validation | **P0** | Non-negotiable (§31) |
| Rate limiting | **P0** | Redis-backed |
| OAuth state validation + token encryption | **P0** | Non-negotiable |
| Audit logging | **P0** | Cheap now, impossible to backfill |
| Webhook signature verification | **P0** | Required before any webhook endpoint exists |
| 2FA | P1 | Needs Identity Platform upgrade (**Q9**) |
| SSO / SAML | P2 | |

### Tenancy & RBAC (§4, §5)

| Feature | Pri |
|---|:--:|
| Organization / Workspace / Brand CRUD | **P0** |
| Memberships + invitations | **P0** |
| RBAC engine + all seven roles | **P0** |
| Tenant-scoped data layer | **P0** |
| Postgres RLS backstop | **P0** |
| Brand-level assignment narrowing | P1 |
| Ownership transfer | P1 |
| Custom roles | P2 |

### Social (§7, §8)

| Feature | Pri |
|---|:--:|
| Provider adapter architecture + capability system | **P0** |
| Facebook Pages: OAuth, connect, health, disconnect | **P0** |
| Facebook: publish text / link / single image | **P0** |
| Facebook: publish multi-image | **P0** |
| Facebook: publish video | P1 |
| Facebook: Reels | P1 |
| Token refresh + reconnection flow | **P0** |
| Instagram | P1 |
| LinkedIn, X | P1 |
| TikTok, YouTube, Threads, Pinterest | P2 |
| Provider webhooks | P2 |

### Content & publishing (§9–§14)

| Feature | Pri |
|---|:--:|
| Composer: text, media attach, multi-account select | **P0** |
| Per-account variants | **P0** |
| Capability-driven validation (client + server) | **P0** |
| Preview | **P0** |
| Drafts + autosave | **P0** |
| Duplicate / delete | **P0** |
| Status state machine (§10) | **P0** |
| Calendar: month + list views | **P0** |
| Calendar: week view | P1 |
| Drag-and-drop reschedule | **P0** |
| Exact scheduling, timezone-aware | **P0** |
| Publish now | **P0** |
| Queue slots / queue-based scheduling | P1 |
| Queue + worker + idempotent publishing | **P0** |
| Retry, backoff, dead-letter | **P0** |
| Publishing logs + manual retry | **P0** |
| Hashtag/mention/emoji helpers | P1 |
| Bulk actions, CSV import | P2 |

### Workflow & collaboration (§11, §15, §16)

| Feature | Pri | Note |
|---|:--:|---|
| Internal review + client review states | **P0** | **C4** — recommendation, pending **Q4** |
| Approve / request changes + comment | **P0** | |
| Approval queue view | **P0** | |
| Client portal: calendar, pending approval, published | **P0** | Minimal surface |
| Production tasks (§11 pipeline) | P1 | Schema ships P0, UI P1 |
| Assignments | P1 | |
| Comments with mentions, resolve threads | P1 | |
| Client portal: analytics + assets | P1 | |
| Activity feed | P1 | |
| White-labelled portal | P2 | **Q12** |

### Media (§17)

| Feature | Pri |
|---|:--:|
| Presigned upload + server-side byte verification | **P0** |
| Media attach in composer | **P0** |
| Signed read URLs + tenant isolation | **P0** |
| Library browse, search, tags, folders | P1 |
| Brand association | P1 |
| Transcoding / auto-resize | P2 |

### Analytics, reporting, AI, billing, admin (§18–§20, §23–§25, §28, §38)

| Feature | Pri | Note |
|---|:--:|---|
| Analytics ingestion + availability map | P1 | Phase 3 |
| Post & account analytics UI | P1 | |
| Agency dashboard + alerts | P1 | Account-health alerts are **P0** (publishing depends on them) |
| Client reports, PDF/CSV export | P1 | |
| Scheduled reports | P2 | |
| Brand Brain storage | P1 | |
| AI caption / rewrite / hashtags | P1 | Phase 4 |
| AI content planning, repurposing | P2 | |
| Performance-informed AI | P2 | |
| Subscription schema + plan limit checks | **P0** | Schema and limits only (§38) |
| Stripe checkout + portal | P1 | |
| Admin: orgs, users, jobs, health | **P0** | Needed to operate the MVP at all |
| Admin: system logs, subscriptions | P1 | |
| Impersonation | P2 | |

### Platform quality (§29–§33, §41)

| Feature | Pri |
|---|:--:|
| Design system + tokens + required UI states | **P0** |
| Responsive desktop/tablet; usable mobile | **P0** |
| Accessibility baseline (semantics, focus, labels, contrast) | **P0** |
| Structured logging + Sentry | **P0** |
| Unit tests: RBAC, isolation, transitions, validation, idempotency | **P0** |
| Integration tests: auth, OAuth, publishing, queue | **P0** |
| E2E: the §32 critical flow | **P0** |
| OpenAPI docs | **P0** |
| Load/performance testing | P2 |

---

## 2. Phase 0 — Foundation

Estimates are **relative complexity points** (Fibonacci-ish), not hours.

| # | Task | Pts |
|---|---|:--:|
| **T0.0** | **Meta app: create, configure, submit for App Review + Business Verification** | 3 |
| T0.1 | Monorepo, TypeScript strict, ESLint/Prettier, CI (typecheck, lint, test, build) | 3 |
| T0.2 | Provision environments: Postgres + pooler, Redis, S3, Firebase projects, Vercel, ECS | 5 |
| T0.3 | Prisma baseline schema + first migration + seed | 5 |
| T0.4 | Env schema validation, secret management, `.env.example` | 2 |
| T0.5 | Design system: tokens, shadcn wrappers, required-state components, app shell | 8 |
| T0.6 | Logging, redaction layer, Sentry, `correlationId` propagation, health endpoints | 3 |
| T0.7 | Error taxonomy + API error envelope + typed handler wrapper | 3 |

**T0.0 runs first and in parallel with everything.** It is a 2–4 week external dependency
(`SOCIAL_PROVIDERS.md` §2 note 1) and is the most likely cause of a missed launch date.

---

## 3. Phase 1 — MVP tasks (§46.J)

Each task carries: **Objective · Modules · Depends on · DB · API · UI · Tests · DoD**.
The universal DoD (§41) applies to every task and is not repeated: *UI + server logic + authz +
validation + migration + loading/empty/error/permission states + tests + `tsc` + lint + build clean
+ no console errors + docs updated.* The per-task DoD lists only what is **specific** to that task.

---

### T1.1 — Authentication & session (5 pts)

- **Objective:** A user can sign up, verify email, sign in (password or Google), reset a password, and hold a verified server-side session.
- **Modules:** `packages/auth`, `apps/web/app/(auth)`, `app/api/v1/auth/*`
- **Depends on:** T0.1–T0.4
- **DB:** `User`
- **API:** `POST|DELETE /auth/session`, `GET|PATCH /auth/me`
- **UI:** Sign-in, sign-up, forgot/reset, verify-email, account settings
- **Tests:** Session cookie verification incl. revocation; expired/tampered cookie rejected; `User` upsert idempotent
- **DoD:** No password material stored by AHN Orbit; sign-out revokes Firebase refresh tokens; cookie is HttpOnly + Secure + SameSite

### T1.2 — Tenancy primitives & tenant-scoped data layer (8 pts)

- **Objective:** Every query is provably scoped to one organization.
- **Modules:** `packages/db` (Prisma `$extends`), `packages/auth` (`TenantContext`)
- **Depends on:** T1.1
- **DB:** `Organization`, `OrganizationMembership`, `Workspace`, `WorkspaceMembership`, `Brand`; RLS policies
- **API:** — (infrastructure)
- **UI:** —
- **Tests:** Un-scoped query on a tenant model throws; RLS blocks a leaked query even with the guard bypassed; concurrent requests never bleed context
- **DoD:** A Prisma client is **not constructible** without a `TenantContext`; RLS enabled on every tenant table

### T1.3 — RBAC engine (8 pts)

- **Objective:** One authorization decision point, used by API, actions, workers, and UI.
- **Modules:** `packages/rbac`, `withAuth()` wrapper, `useCan()` hook
- **Depends on:** T1.2
- **DB:** — (reads memberships)
- **API:** `GET /auth/me` returns effective permissions
- **UI:** Permission-aware controls; `<PermissionDenied/>`
- **Tests:** **The `RBAC.md` matrix as an executable fixture** — every role × permission cell
- **DoD:** No route handler or server action can reach Prisma without passing through `withAuth()`; drift between `RBAC.md` and the engine fails CI

### T1.4 — Organizations, workspaces, brands, invitations (8 pts)

- **Objective:** An agency can set itself up: org, clients, brands, teammates.
- **Modules:** `apps/web/features/{organizations,workspaces,brands,users}`
- **Depends on:** T1.3
- **DB:** `Invitation`; slug uniqueness; `Subscription` created with the org
- **API:** §2.2, §2.3 of `API.md`
- **UI:** Org onboarding, workspace list/detail, brand CRUD, member management, invite accept
- **Tests:** Slug collisions; invite token single-use and expiring; last-owner removal blocked; cross-tenant 404
- **DoD:** Workspace timezone is required at creation (§36); only the invite token *hash* is stored

### T1.5 — Provider framework & capability system (8 pts)

- **Objective:** The publishing core has zero platform-specific code.
- **Modules:** `packages/providers` (`types`, `registry`), `packages/contracts`
- **Depends on:** T0.7
- **DB:** —
- **API:** `GET /social-accounts/{id}/capabilities`
- **UI:** —
- **Tests:** Registry resolution; capability descriptor schema validation; error normalisation for every §37 class
- **DoD:** `SocialProvider` and `PlatformCapabilities` finalised; a mock provider passes the full contract suite; the mock is unreachable in production builds

### T1.6 — Facebook OAuth & account connection (8 pts)

- **Objective:** Connect one or more Facebook Pages to a brand, with encrypted credentials.
- **Modules:** `packages/providers/facebook/{oauth,client}`, `features/social`
- **Depends on:** T1.5, T0.0 *(a Test App suffices to build; the reviewed app is needed to ship)*
- **DB:** `SocialAccount`, `SocialCredential`
- **API:** §2.4 of `API.md`
- **UI:** Connect flow, Page picker (a Meta user often admins many Pages), account cards with status
- **Tests:** State signed/single-use/TTL-bound; code exchange happens server-side only; AES-256-GCM round-trip with key rotation; duplicate connection ⇒ 409
- **DoD:** No token in any response, log, or client bundle; `keyVersion` recorded on every credential

### T1.7 — Account health & reconnection (5 pts)

- **Objective:** A broken token is detected and surfaced before it silently breaks publishing.
- **Modules:** `apps/worker/jobs/account-health`, `features/social`
- **Depends on:** T1.6, T1.11
- **DB:** `SocialAccount.status`, `healthCheckedAt`, `healthError`
- **API:** `GET /social-accounts/{id}/health`, `POST /{id}/reconnect`
- **UI:** Needs-reconnect banner, per-account health badge, reconnect flow
- **Tests:** Auth error ⇒ `NEEDS_RECONNECT` + queue paused + notification; recovery restores `ACTIVE`
- **DoD:** Health is probe-driven, not expiry-driven (`SOCIAL_PROVIDERS.md` §4)
- **Status:** ✅ **DONE** (2026-08-12). `packages/core/account-health.ts` (pure
  decisions), `apps/worker/src/health/*` + the `account-health` processor and an
  hourly sweep, `POST /social-accounts/{id}/reconnect`, and the accounts page
  with a health badge and a needs-reconnect banner (also shown on the publishing
  page). 17 unit + 34 integration tests. Three decisions worth reading: **D-031**
  (health probes get their own rate-limit bucket), **D-032** (the scheduler sweep
  skips variants whose account is broken, without cancelling them) and **D-033**
  (notification rows are written now; delivery is T1.15). No migration — every
  column already existed. The gap this closed: nothing previously moved an
  account to `NEEDS_RECONNECT`, so a dead token failed every post identically
  while the accounts page reported all well.

### T1.8 — Media upload & verification (8 pts)

- **Objective:** Safe, tenant-isolated media that the composer can attach.
- **Modules:** `packages/storage`, `features/media`, `apps/worker/jobs/media`
- **Depends on:** T1.3
- **DB:** `MediaAsset`, `MediaFolder`
- **API:** §2.7 of `API.md`
- **UI:** Uploader with progress, basic grid, attach-in-composer picker
- **Tests:** **Declared MIME ≠ actual bytes ⇒ rejected**; oversize rejected; traversal-style filenames neutralised; signed URL expiry; cross-tenant asset ⇒ 404
- **DoD:** Bucket blocks all public access; keys derived, never user-supplied; assets stay `PENDING` until byte verification passes

### T1.9 — Post model, state machine & composer (13 pts)

- **Objective:** Create a post for several Facebook Pages, with per-account variants, validated against real platform rules.
- **Modules:** `packages/core/posts`, `features/{posts,composer}`
- **Depends on:** T1.4, T1.5, T1.8
- **DB:** `Post`, `PostVariant`, `PostMedia`
- **API:** §2.5 of `API.md`
- **UI:** Composer (editor, account selector, per-account tabs, media, preview, autosave, validation panel)
- **Tests:** Every legal transition allowed and every illegal one rejected; `PUBLISHING` unreachable by any human role; identical validation results client-side and server-side; autosave conflict detection
- **DoD:** Status is **not** writable via `PATCH` — only via `/transition`; validation runs from the capability descriptor, never hardcoded limits
- **Status:** ✅ **DONE** (2026-08-12). 35 integration tests in
  `features/posts/posts.integration.test.ts`. Uncovered a real defect —
  the reopen transitions were unreachable for every role; see **D-016**.
  Deferred to a follow-up: `/preview` (the composer renders per-account text and
  counts inline for now), and drag-to-reorder on media.

### T1.10 — Approval workflow, minimal (8 pts) — *pending **Q4***

- **Objective:** Content passes an internal gate and a client gate before it can be scheduled.
- **Modules:** `packages/core/approvals`, `features/approvals`
- **Depends on:** T1.9
- **DB:** `Approval`, `Comment` (with `visibility`), `ProductionTask` (schema only)
- **API:** §2.6 of `API.md`
- **UI:** Approval queue, approve / request-changes with comment, status timeline
- **Tests:** Only permitted roles decide; approvals void on reopen; a client cannot decide on another workspace's post
- **DoD:** Editing an approved post requires an explicit reopen that voids prior approvals
- **Status:** ✅ **DONE** (2026-08-12). 39 integration tests in
  `features/approvals/approvals.integration.test.ts`, 11 unit tests in
  `packages/core/src/approvals.test.ts`. **Q4 is resolved** by the approved plan —
  the gate ships in P0, as recommended (**C4**). See **D-017**, **D-018**, **D-019**.
  Deferred: `ProductionTask` UI (P1, schema already ships), comment mentions
  notifications (T1.15), threaded reply UI (P1 — the API supports threads).

### T1.11 — Queue infrastructure & worker service (8 pts)

- **Objective:** A deployable worker on ECS that consumes BullMQ reliably.
- **Modules:** `packages/queue`, `apps/worker`, `infra/`
- **Depends on:** T0.2, T0.6
- **DB:** —
- **API:** —
- **UI:** —
- **Tests:** Payload schema validation; graceful shutdown drains in-flight jobs; failed jobs reach the DLQ with the full error chain
- **DoD:** Docker image + ECS task definition + autoscaling; the web app **never** constructs a `Worker`; queue depth and age exported as metrics
- **Status:** ✅ **DONE** (2026-08-12). `packages/queue` + `apps/worker` +
  `infra/ecs/`. 47 unit tests, 30 integration tests against real Redis.
  See **D-020** (retry policy), **D-021** (job tenant derivation), **D-022**
  (producer/consumer split). Worker boot, `/health`, `/metrics` and a full
  SIGTERM drain verified against the built artifact.
  Ships the runtime plus the `maintenance` queue; the other five processors land
  with their features (their queues and payload schemas already exist, so each
  is a `startWorker` line).

### T1.12 — Scheduling & calendar (13 pts)

- **Objective:** Schedule a post to the right moment in the right timezone, and move it by dragging.
- **Modules:** `packages/core/scheduling`, `features/{calendar,scheduling}`
- **Depends on:** T1.9, T1.11
- **DB:** `PostVariant.scheduledFor` + partial index; `QueueSlot` (schema)
- **API:** `POST /posts/{id}/schedule`, `/cancel`, calendar list endpoint
- **UI:** Month + list views, all §12 filters, drag-and-drop reschedule with optimistic update
- **Tests:** **Both DST transitions**, explicitly; workspace vs user timezone display; sweep picks up due variants within tolerance; reschedule cancels cleanly
- **DoD:** All timestamps stored UTC; scheduling resolves in workspace timezone; UI shows both zones when they differ (**C5**)
- **Status:** ✅ **DONE** (2026-08-12). `packages/core/{timezone,scheduling}.ts`,
  `features/scheduling`, `apps/worker/src/processors/scheduler.ts`. 65 unit tests
  (both DST transitions in three zones), 44 integration tests.
  See **D-023** (DST policy), **D-024** (no timezone library), **D-025** (sweep queue).
  No migration needed — the partial index and the `status`/`scheduledFor` check
  constraint were already in place from T0.3.
  Deferred: drag-to-*time* within a day (dragging moves the date, keeping the
  time of day), and a queue-slot editor UI (slots are read and honoured; they
  are seeded directly for now).

### T1.13 — Publishing engine (13 pts)

- **Objective:** Publish exactly once, or fail loudly and recoverably.
- **Modules:** `apps/worker/jobs/publish`, `packages/core/publishing`, `providers/facebook/publish`
- **Depends on:** T1.6, T1.11, T1.12
- **DB:** `PublishingJob`, `PublishingAttempt`, `PostVariant.claimedAt/claimToken`
- **API:** `POST /posts/{id}/publish-now`
- **UI:** Publishing status on post detail and calendar
- **Tests:** **Duplicate job ⇒ one publish; concurrent workers ⇒ one publish; simulated timeout ⇒ reconciliation, not a second post; worker crash mid-publish ⇒ recovered without duplication; rate limit ⇒ reschedule without consuming an attempt; auth error ⇒ no retry**
- **DoD:** All four idempotency layers implemented (`ARCHITECTURE.md` §5.2); an inconclusive reconciliation parks the variant for a human and **never** guesses
- **Status:** ✅ **DONE** (2026-08-12). `packages/core/publishing.ts`,
  `apps/worker/src/publishing/{claim,attempts,rollup,subject,engine}.ts`,
  `features/publishing`. 22 unit tests, 32 integration tests against real
  Postgres, real Redis and the mock's fault injection — including both
  `TIMEOUT_THEN_PUBLISHED` and `TIMEOUT_NOT_PUBLISHED`, three concurrent workers
  on one variant, and worker-crash recovery.
  See **D-026** (post travels through PUBLISHING), **D-027** (park, never
  guess), **D-028** (publish-now is scheduling for the present).
  No migration needed — `PublishingJob`, `PublishingAttempt` and the claim
  columns were already in place from T0.3.
  Deferred to T1.14: the job browser and attempt-timeline UI (the API and the
  ledger exist; `GET /posts/{id}/publishing` serves it).

### T1.14 — Publishing logs & failure handling (5 pts)

- **Objective:** When publishing fails, a human can see why and fix it.
- **Modules:** `features/publishing`
- **Depends on:** T1.13
- **DB:** — (reads attempts)
- **API:** §2.8 of `API.md`
- **UI:** Job list with filters, attempt timeline, error detail, manual retry, reconnect prompt
- **Tests:** Retry is idempotent; no credential or raw provider payload appears in any response
- **DoD:** Every §37 error class renders a useful human message; provider metadata is whitelisted before storage
- **Status:** ✅ **DONE** (2026-08-12). `packages/core/failure-presentation.ts`,
  `features/publishing/{logs,resolve,contracts}.ts`, the publishing log page and
  the attempt timeline. 12 unit tests (every `ErrorCode` has an explanation and
  an action — exhaustiveness is a type error), 34 integration tests.
  See **D-029** (resolving a parked publish) and **D-030** (confirming a publish
  requires the post id).
  No migration needed. Closes the gap T1.13 left: a parked `NEEDS_REVIEW`
  variant now has a door out, and it leads back through the engine rather than
  around it.

### T1.15 — Notifications, core (5 pts)

- **Objective:** People find out about failures and pending approvals without watching a dashboard.
- **Modules:** `features/notifications`, `apps/worker/jobs/notifications`
- **Depends on:** T1.10, T1.13
- **DB:** `Notification`
- **API:** §2.11 of `API.md`
- **UI:** Notification bell, list, mark-read, per-type email preferences
- **Tests:** Fan-out respects permissions (no notification about a post you cannot see); email failure does not lose the in-app record
- **DoD:** Covers publishing failure, disconnected account, approval requested, changes requested (§22)
- **Status:** ✅ **DONE** (2026-08-12), **in-app only — email deliberately not
  wired** (**D-034**, user decision). New package `@orbit/notifications` (types,
  copy, channel selection, RBAC-aware fan-out, writer, reader), the
  `notifications` processor, producers in the publishing engine and
  `transitionPost`, `GET/POST` routes under `/orgs/{id}/notifications`, and a
  polling notification bell in a new organization shell. 11 unit + 28
  integration tests. No migration — `Notification` and `NotificationChannel`
  already existed, `emailedAt` included.
  Decisions: **D-034** (email is a seam, not a stub), **D-035** (fan-out is
  authorized, not addressed — the DoD's "no notification about a post you cannot
  see"), **D-036** (the package, and the T1.7 duplication it absorbed),
  **D-037** (inline vs queued producers, and the one deliberate identity field
  in a payload).
  **Not built:** email delivery and per-type email preferences — both are
  T1.15's remaining half and neither changes the domain when it lands.

### T1.16 — Client portal, minimal (8 pts)

- **Objective:** A client reviews and approves their content, and sees nothing else.
- **Modules:** `apps/web/app/(portal)`, `features/portal`
- **Depends on:** T1.10
- **DB:** —
- **API:** §2.12 of `API.md`
- **UI:** Portal shell, calendar, pending approvals, post preview, approve/request-changes, published list
- **Tests:** **Payload-level leakage tests** — internal comments, internal approvals, other brands, audit and cost data absent from every portal response; a client hitting an agency route is refused
- **DoD:** Portal uses its own services and narrowed selects — not agency endpoints with a filter (§21)
- **Status:** ✅ **DONE** (2026-08-12). `withPortalAuth` (tenant derived from the
  subject, never the URL), `features/portal/{projection,service,actions,contracts}.ts`,
  seven routes under `/api/v1/portal/`, and a `(portal)` route group with review,
  upcoming, published and post pages. 26 integration tests that run the **real
  route handlers** and assert on the **serialised payload**.
  Decisions: **D-038** (the portal is client-only and the agency API is
  client-free, both 404), **D-039** (portal owns its reads, delegates its
  writes — one state machine), **D-040** (client status vocabulary is a
  translation, not a second enum).
  **Bug fixed:** a Client reaching agency routes got a 200 with an agency-shaped
  payload — `withAuth` now refuses them. **Leak caught by the new tests:** the
  comment projection carried the agency author's user id.
  No migration, no new permissions.
  **Not built:** portal analytics and assets (both listed in `API.md` §2.12 and
  both depending on features that do not exist yet — analytics is Phase 3, client
  uploads are open question **O2**).

### T1.17 — Agency dashboard & account-health alerts (5 pts)

- **Objective:** One screen that tells the agency what needs attention today.
- **Modules:** `features/dashboard`
- **Depends on:** T1.13, T1.15
- **DB:** — (aggregations)
- **API:** `GET /orgs/{orgId}/dashboard`
- **UI:** Per-client status counts, next post, account health, alert list
- **Tests:** Counts respect RBAC scope; aggregation is a single grouped query, not N+1
- **DoD:** Alerts cover approval backlog, expired authorization, publishing failures, disconnected accounts (§20)
- **Status:** ✅ **DONE** (2026-08-12). `features/dashboard/{alerts,service}.ts`,
  `GET /orgs/{orgSlug}/dashboard`, and a `Today` page wired into the org shell as
  its landing surface. 16 unit + 13 integration tests.
  Per-client figures come from **one `groupBy(['workspaceId', 'status'])`**; the
  whole dashboard is a fixed query count regardless of client, account or post
  volume, pinned by a test that runs it against two workspaces then six and
  requires the count to be identical (**D-042** explains how that became
  observable). All six DoD alert conditions covered: approval backlog, accounts
  needing reconnection, disconnected accounts, publishing failures, parked
  publishes, overdue schedules.
  Decisions: **D-041** (gated on `org:read`, since `post:read` is workspace-scoped
  and would deny a Creator an overview), **D-042** (query events outside
  production, so the no-N+1 property is testable).
  No migration, no new permissions.
  **Not built:** per-alert dismissal and any notion of "acknowledged" — an alert
  clears when the condition does, which is the honest behaviour while every
  condition is derived rather than stored.

### T1.18 — Platform admin, minimal (5 pts)

- **Objective:** Operate the system: see orgs, jobs, dead letters, health.
- **Modules:** `apps/web/app/(admin)`
- **Depends on:** T1.11, T1.13
- **DB:** —
- **API:** §2.13 of `API.md`
- **UI:** Org list, user list, job browser with retry, account-status board, health page
- **Tests:** Non-admins get 404 on every admin route; **no admin response contains credential material, masked or otherwise**
- **DoD:** Admin actions against tenant data are audited with an actor and a reason
- **Status:** ✅ **DONE** (2026-08-12). `withPlatformAdmin` (a third wrapper,
  producing **no `TenantContext`** — so an admin handler cannot construct a
  scoped client at all), `platformAudit`, `features/admin/{service,contracts}.ts`,
  eight routes under `/api/v1/admin/`, and an `(admin)` route group with health,
  dead letters, organizations, users and connections. 14 integration tests.
  Decisions: **D-043** (third wrapper, no tenant context, permissions reused),
  **D-044** (connection *status*, never connection *identity*), **D-045**
  (`publish` cannot be re-enqueued from the admin panel — **needs review**),
  **D-046** (admin actions audited into the tenant's own log with a mandatory
  reason).
  **Bug fixed:** `AuditLog.resourceId` is `@db.Uuid` and a dead-letter id is a
  Redis key, so the first audit write failed on a Postgres cast; non-UUID ids
  now travel in the snapshot and `platformAudit` rejects a bad one as a
  programming error.
  No migration, no new permissions.
  **Not built:** `org:suspend` — the permission exists and no endpoint uses it,
  because suspension semantics (what happens to a suspended org's scheduled
  posts) are product behaviour rather than plumbing. `admin:impersonate` remains
  P2 and unbuilt by design.

### T1.19 — Observability, docs & E2E (5 pts)

- **Objective:** Ship something operable and documented.
- **Modules:** cross-cutting
- **Depends on:** all
- **Tests:** The §32 E2E flow end to end: *login → create org → workspace → brand → connect account → create post → submit → approve → schedule → publish* (against the mock provider in CI, and once manually against a real Test Page)
- **DoD:** `README.md`, `ARCHITECTURE.md`, `DATABASE.md`, `API.md`, `SECURITY.md`, `SOCIAL_PROVIDERS.md`, `DEPLOYMENT.md` all current (§44); OpenAPI served; Sentry receiving from both apps; dashboards for queue depth, publish success rate, and error rate
- **Status:** ✅ **DONE** (2026-08-12), with one DoD line partly met — see below.
  `packages/observability/{metrics,reporting}.ts`, publish/provider/job
  instrumentation surfaced on the worker's `/metrics`, deep health extended to
  Redis and storage, `GET /api/v1/openapi.json`, and a third test project
  (`pnpm test:e2e`) running the whole §32 flow in 19 ordered steps plus the
  ambiguous-publish case.
  New docs: `SECURITY.md`, `RUNBOOK.md`, `DEPLOYMENT.md`. `README.md` rewritten —
  it still claimed the repository was pre-implementation.
  Decisions: **D-047** (tests never reach a real platform unless asked by name),
  **D-048** (Sentry is a seam, not a stub).
  **Bug fixed:** the E2E flow published to `graph.facebook.com` on its first run,
  because `validatePost` re-registers the real adapter whenever Meta credentials
  are configured. See **D-047**.
  **Partly met:** "Sentry receiving from both apps" — the seam and every call
  site exist; no SDK is installed and nothing has been observed arriving
  (**D-048**). "Dashboards" ships the *metrics and the alarm expressions*
  (`RUNBOOK.md` §2), not a provisioned Grafana.
  No migration, no new permissions.

---

## 4. Dependency order

```
T0.0 (Meta App Review) ══════════════ runs in parallel, gates production launch ══════════════▶

T0.1 → T0.2 → T0.3 → T0.4 ─┬─→ T0.5 (design system) ─┐
                            ├─→ T0.6 (observability)  │
                            └─→ T0.7 (errors) ────────┤
                                                       ▼
T1.1 (auth) → T1.2 (tenancy) → T1.3 (RBAC) → T1.4 (org/ws/brand)
                                                 │
                     ┌───────────────────────────┼──────────────┐
                     ▼                           ▼              ▼
              T1.5 (providers)            T1.8 (media)   T1.11 (queue/worker)
                     │                           │              │
                     ▼                           │              │
              T1.6 (FB OAuth) ───────────────────┤              │
                     │                           │              │
                     └──────────┬────────────────┘              │
                                ▼                               │
                        T1.9 (posts + composer)                 │
                                │                               │
                    ┌───────────┼─────────────┐                 │
                    ▼           ▼             ▼                 │
             T1.10 (approvals)  T1.12 (scheduling) ◀────────────┘
                    │                   │
                    │                   ▼
                    │            T1.13 (publishing) ──▶ T1.7 (health) · T1.14 (logs)
                    │                   │
                    ▼                   ▼
             T1.16 (portal)      T1.15 (notifications) → T1.17 (dashboard) → T1.18 (admin)
                                                                                   │
                                                                                   ▼
                                                                            T1.19 (obs/docs/E2E)
```

**Critical path:** `T1.1 → T1.2 → T1.3 → T1.4 → T1.9 → T1.12 → T1.13`.
Media (T1.8), queue infrastructure (T1.11), and the provider framework (T1.5/T1.6) parallelise well
across two engineers.

**Total Phase 1 ≈ 152 points** (Phase 0 ≈ 32 + Phase 1 ≈ 120), consistent with the 7–9 week Phase 1
estimate in `00-ANALYSIS.md` §Estimation at ~2 engineers.

---

## 5. Working agreements

1. **No feature is "done" until §41 is satisfied.** A merged PR with a missing empty state is not done.
2. **No provider-specific code outside `packages/providers/{platform}`.** Enforced by an ESLint
   boundary rule, not by reviewer memory.
3. **No new capability marked supported in `SOCIAL_PROVIDERS.md` without a documentation link.**
4. **Every new endpoint ships with a cross-tenant 404 test** in the same PR.
5. **Every decision that changes architecture is appended to `DECISIONS.md`** (§48) in the PR that
   makes it — not afterwards.
6. **Mock providers never ship to production.** Guarded by environment and by a build-time check (§42).
