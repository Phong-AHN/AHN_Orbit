# AHN Orbit — Initial Requirement Analysis

> Status: **pre-implementation**. This document answers SRS §46.A–D, §47 (estimation) and the
> technical-risk portion of §50. No application code has been written.
> Last updated: 2026-08-11.

---

## A. Requirement Analysis (product in our own words)

AHN Orbit is a **multi-tenant content operations platform for a social media agency**. Its unit of
value is not "a scheduled post" — that is a commodity — but **the trip a piece of content takes
from idea to published, across an agency and its clients, with an auditable approval trail**.

Three products are fused into one:

1. **A social publishing tool.** Compose once, adapt per platform, validate against each platform's
   real rules, schedule in the right timezone, publish reliably and exactly once, prove it happened.
2. **An agency operations tool.** Many clients, many brands, many people, each seeing only what
   their role permits. Work is assigned, reviewed, chased, and reported on.
3. **A client-facing collaboration surface.** External clients approve or reject content in a
   deliberately narrow portal that leaks nothing about agency internals.

AI (§23–25) is an accelerant layered on top of all three, grounded in per-brand context ("Brand
Brain"), and never permitted to publish autonomously.

The system's two hardest guarantees, which drive nearly every architectural decision:

- **Tenant isolation** — server-enforced, defence-in-depth, provable by test (§4, §31).
- **Exactly-once publishing** — idempotent in the face of retries, crashes, and timeouts (§13, §31).

Everything else is, architecturally, ordinary application work.

### What "done" means here

§41 sets a high bar: a feature ships only with UI + server logic + authorization + validation +
migrations + loading/empty/error/permission states + tests + docs. That bar is realistic but it
roughly **doubles** naive feature estimates. The estimates in §Estimation below assume it.

---

## B. Ambiguities

Every item below is a genuine gap in the SRS — not a preference. Each is resolved for now by a
matching assumption in §C, and the material ones are escalated to questions in §D.

### B1. "Workspace / Client" is one level or two (§4)
The hierarchy writes `Workspace / Client` as a single tier, but §21 talks about clients being
assigned to *multiple* "Organizations, Workspaces, Brands". If a Client is an entity that can span
workspaces, that is a different schema than Workspace-is-the-client.

### B2. Two overlapping workflow models (§10 vs §11)
§10 defines a **status enum** (`IDEA → DRAFT → INTERNAL_REVIEW → … → PUBLISHED`). §11 defines a
**production pipeline** (`Idea → Copywriting → Design → Internal Review → …`) whose stages are
individually assignable. These are different axes: a post can be in `DRAFT` status while its
*Design* stage is assigned to someone. Modelling them as one enum loses information; modelling them
as two needs a defined relationship between them.

### B3. Variant granularity: per platform or per account (§9)
§9 says "platform-specific variants". But publishing, external post IDs, per-target failure, and
retry are all **per social account**. Two Facebook Pages selected on one post need two independent
publish outcomes even if they share identical copy.

### B4. Approval is Phase 2, but the product thesis is approvals (§15 vs §39)
§39 Phase 1 stops at Publishing; approvals land in Phase 2. Yet §49 names approval workflows as core
identity, and an agency tool that publishes without an approval gate is a worse Buffer. Shipping
Phase 1 to real clients without *any* gate may not be usable in production.

### B5. Timezone precedence is undefined (§12 vs §36)
§12 says display "according to the relevant workspace/account/user timezone" — three sources. §36
says scheduling respects the *Workspace* timezone. Which wins for display, and does a user's
personal timezone preference override the workspace's?

### B6. "Database hosting: PostgreSQL Prisma" (§51)
Ambiguous between at least: Prisma Postgres (managed), AWS RDS, Neon, or Supabase. This determines
connection pooling strategy, whether Postgres RLS is available, backup/PITR posture, and cost.

### B7. Redis reachability is unspecified (§27, §51)
"Redis + BullMQ" plus "Vercel + AWS" does not say *where* Redis lives. AWS ElastiCache is
VPC-private and **not reachable from Vercel serverless functions** without Secure Compute /
VPC peering (Enterprise-tier). This is a hard infrastructure fork, not a detail.

### B8. Client users: seats, billing, and identity (§21, §38)
Are external client users billable seats? Do they authenticate through the same Firebase project as
agency staff? Can one person be a Client in one org and a Content Creator in another?

### B9. "Optional 2FA" scope (§6)
Firebase Auth's MFA (TOTP/SMS) requires upgrading the project to **Google Cloud Identity Platform**.
Is 2FA in MVP scope, and is that upgrade (and its per-MAU pricing change) acceptable?

### B10. Analytics backfill window and refresh cadence (§18)
Not specified: how far back to backfill on connect, how often to poll, and how long to retain
snapshots. This drives job volume, API quota consumption, and storage.

### B11. Media processing expectations (§17)
The SRS lists formats and security but never says whether AHN Orbit **transcodes/resizes** media to
satisfy platform constraints, or merely validates and rejects. Transcoding is a whole subsystem
(ffmpeg, a separate worker class, cost).

### B12. Publishing SLA / scheduling precision (§12, §13)
"Exact scheduling" is stated without a tolerance. ±30s and ±5min imply very different scheduler
designs and cost.

### B13. Soft delete semantics (§26)
A soft-delete strategy is required but its scope is undefined: does deleting a Brand soft-delete its
posts? Do soft-deleted rows still count against plan limits? Are published posts ever deletable
locally without deleting remotely?

### B14. Audit log retention and visibility (§16, §28)
Who can read the audit trail — Org Owner only, or Admins too? Can clients see the audit trail of
their own approvals? Retention period is unspecified.

---

## C. Assumptions

Each is marked **ASSUMPTION**, with rationale and the alternative we did not take, per §2.

**ASSUMPTION C1 — A Workspace *is* a Client.**
One Workspace = one client of the agency, owning one or more Brands. External client users are
granted membership on a Workspace, not on a separate Client entity.
*Why:* it is the simplest reading of §4, and every §12 filter ("Client", "Workspace") then maps to
one column. *Alternative:* a distinct `Client` entity with many Workspaces (e.g. a holding company
with several sub-brands each needing separate billing). That is a bigger schema and, if needed
later, is a migration — hence question **Q1 (P0)**.

**ASSUMPTION C2 — Status and production stage are separate, related models.**
`Post.status` implements the §10 enum and is the only thing that gates publishing.
`ProductionTask` rows implement the §11 pipeline (`COPYWRITING`, `DESIGN`, …) with their own
assignee/state, and a post cannot leave `DRAFT` while a *blocking* production task is open.
*Why:* preserves both axes without a combinatorial enum. *Alternative:* one flat enum merging both —
rejected because "who owns the design work right now" becomes unrepresentable.

**ASSUMPTION C3 — The publishable unit is `PostVariant`, one per (post × social account).**
Platform-level editing in the composer is a UI affordance that writes through to all variants of
that platform; the stored row is per account.
*Why:* per-account external IDs, failures, and retries are unavoidable. *Alternative:* per-platform
variants with a join table to accounts — same data, more indirection at publish time.

**ASSUMPTION C4 — MVP ships a minimal approval gate.**
`INTERNAL_REVIEW` and `CLIENT_REVIEW` states, approve / request-changes, and a read-only client
approval queue are in P0. The full client portal (analytics, assets, comments threading) stays P1.
*Why:* §49 makes approvals the product's reason to exist, and the state machine is far cheaper to
build up front than to retrofit under published data. *Alternative:* strict §39 phasing — see
question **Q4 (P0)**. This is a **recommendation, not a unilateral scope change.**

**ASSUMPTION C5 — Timezone precedence: Workspace for scheduling, User for display.**
All timestamps stored UTC. Scheduling semantics (queue slots, "9am Tuesday") resolve in the
**Workspace** timezone. The UI renders in the **user's** timezone with the workspace time shown
alongside whenever they differ.
*Why:* satisfies §36 for correctness and §12 for usability. *Alternative:* workspace timezone
everywhere — less confusing to build, more confusing for a distributed team.

**ASSUMPTION C6 — Next.js on Vercel; BullMQ workers on AWS ECS Fargate; Redis on Upstash.**
See `ARCHITECTURE.md`. Vercel functions cap at 800s (1800s beta) and cannot host a process holding a
blocking Redis connection, so workers **must** live elsewhere; "Vercel + AWS" (§51) already
anticipates this. Upstash is chosen over ElastiCache for MVP purely because it is reachable over TLS
from **both** Vercel and ECS with no VPC work.
*Alternative:* ElastiCache + all enqueues proxied through an internal API on ECS — cheaper at scale,
more moving parts on day one. See question **Q2 (P0)**.

**ASSUMPTION C7 — Authorization data lives in Postgres, not Firebase custom claims.**
Firebase Auth owns *identity* (credentials, verification, reset, Google, MFA). Every request
exchanges a Firebase ID token for an HttpOnly session cookie, verified server-side by the Admin SDK;
roles and memberships are then read from Postgres.
*Why:* custom claims are capped at 1000 bytes, propagate on token refresh (up to an hour stale), and
cannot express per-workspace/per-brand grants for a user in many orgs. Revocation must be instant.
*Alternative:* a single `platformAdmin` boolean in claims as a fast path — acceptable, adopted only
for that one flag.

**ASSUMPTION C8 — Postgres RLS is defence-in-depth, not the primary control.**
Primary enforcement is a tenant-scoped data-access layer that injects `organizationId` into every
query; RLS is enabled as a second, independent net.
*Why:* Prisma + RLS requires a transaction-scoped `SET LOCAL`, which is workable but fragile as the
sole guarantee. *Alternative:* RLS-first — rejected as primary, kept as backstop. Requires a
Postgres we control (see **Q3**).

**ASSUMPTION C9 — MVP validates media, it does not transcode.**
Files violating platform constraints are rejected at upload with an actionable message.
Server-side transcoding is P2. *Alternative:* ffmpeg on a dedicated worker class — a subsystem in
its own right, not MVP.

**ASSUMPTION C10 — Scheduling tolerance is ±60 seconds.**
A repeatable scheduler sweeps due variants every 30s and enqueues them. *Alternative:* per-post
delayed jobs with second-level precision — more precise, far more scheduled-job churn on reschedule.

**ASSUMPTION C11 — Analytics: 30-day backfill on connect; refresh every 6h for 28 days post-publish,
then daily.** Snapshots retained 25 months for year-over-year reporting.
*Why:* bounded quota and storage while covering the reporting window §19 implies.

**ASSUMPTION C12 — Soft delete on tenant-owned content; hard delete on join rows.**
`deletedAt` on Post, MediaAsset, Brand, Workspace, SocialAccount. Deleting a parent soft-deletes
descendants. Soft-deleted rows do **not** count toward plan limits. Deleting a published post in
AHN Orbit never deletes it on the platform unless the user explicitly asks.

**ASSUMPTION C13 — Facebook Pages only at launch, but the adapter ships plural.**
The provider interface and capability system are built for N providers from day one; only
`FacebookProvider` is implemented in P0. Instagram is the cheapest second provider (same Meta app,
same Graph API, same App Review submission) and is the P1 default.

**ASSUMPTION C14 — 2FA is P1, and requires an Identity Platform upgrade.**
Excluded from MVP; the auth layer is written so enabling it is a configuration change. See **Q9**.

---

## D. Clarification Questions

### P0 — Blocking (architecture or schema cannot be finalised without an answer)

**Q1. Is a Workspace the same thing as a Client?**
Or must one client own several workspaces (separate billing, separate teams)?
*Blocks:* the entire tenancy schema and every scoping query. See **B1/C1**.

**Q2. Where does Redis live, and is Vercel Pro or Enterprise in play?**
Upstash (public TLS, works everywhere, MVP-friendly) vs. ElastiCache (VPC-private, needs Vercel
Enterprise Secure Compute or an ECS-side enqueue proxy)?
*Blocks:* queue topology, enqueue path, and networking. See **B7/C6**.

**Q3. What exactly is the Postgres host — Prisma Postgres, AWS RDS, Neon, or Supabase?**
*Blocks:* connection pooling (Prisma + serverless needs a pooler), whether we can enable RLS and
create roles, PITR/backup posture, and per-environment cost. See **B6/C8**.

**Q4. Does MVP ship with an approval gate, or strictly follow §39's phase boundary?**
We recommend a minimal gate in P0 (**C4**) — retrofitting an approval state machine under live
published content is materially more expensive than building it now.
*Blocks:* the post state machine, which everything else keys off. See **B4**.

**Q5. Has the Meta app been created, and has Business Verification started?**
Publishing to real client Pages requires `pages_manage_posts`, `pages_read_engagement`,
`pages_show_list` (plus `pages_manage_engagement` for comments), **all gated behind full App Review
and Business Verification** — realistically 2–4 weeks including one revision round.
*Blocks:* the entire Phase 1 critical path. This should start **this week**, in parallel with
architecture, or it becomes the launch date. See **R1**.

**Q6. Which Facebook Page surfaces must MVP publish to — feed text/link, single photo, multi-photo,
video, Reels?** Each is a different endpoint, upload protocol, and validation set. Reels and video
use the Resumable Upload API and roughly double composer + worker scope.
*Blocks:* composer, validation, media pipeline, and worker design.

### P1 — Important (affects sequencing and effort, not the core schema)

**Q7.** Are external client users billable seats, and do they live in the same Firebase project as
agency staff? Can one person hold roles in more than one organization? (**B8**)

**Q8.** What is the pricing/plan shape for MVP — one plan, or plan-gated limits (workspaces, social
accounts, AI credits) enforced from day one? §38 says "Stripe-ready", which we read as *schema and
limit-checks present, checkout deferred*. Confirm.

**Q9.** Is 2FA required at launch? It requires upgrading Firebase Auth to Identity Platform, which
changes pricing. (**B9/C14**)

**Q10.** Confirm the analytics backfill/refresh/retention policy in **C11**, and who pays for the
quota. Note that Facebook Page Insights **no longer serves `page_impressions` or `page_fans`** — see
`SOCIAL_PROVIDERS.md`; historical parity with Meta Business Suite is not achievable.

**Q11.** Is there a launch date or client commitment driving scope? §40 says to use it to adjust
scope; we have none.

**Q12.** Must the client portal be brandable (agency logo/colour, custom domain)? White-labelling
touches routing, theming, and email templates and is much cheaper decided now than later.

### P2 — Nice to have

**Q13.** Post-publish comment/DM management (§7 mentions `pages_manage_engagement`) — in roadmap or
out of scope entirely?
**Q14.** Any data-residency requirement (EU tenants) that would constrain S3 region or Firebase
project location?
**Q15.** Expected scale at 12 months — organizations, social accounts, posts/day? Current design
targets ~100 orgs / ~2k accounts / ~5k posts per day without sharding.
**Q16.** Does the agency need a bulk CSV import of a content calendar for onboarding new clients?

---

## Technical Risks

Ordered by expected impact on the launch date.

| # | Risk | Impact | Likelihood | Mitigation |
|---|------|--------|-----------|------------|
| **R1** | **Meta App Review + Business Verification** gates all real publishing. 5–10 business days initial, 2–4 weeks with a revision round. | **Critical** — hard blocker on Phase 1 delivery | High | Submit in week 1, before feature work completes. Record a screencast of the full connect→compose→approve→publish flow early. Develop against a Test App + test Pages meanwhile. |
| **R2** | **Vercel cannot host BullMQ workers.** Functions cap at 800s (1800s beta); a worker holds a blocking Redis connection indefinitely. | High — invalidates a naive "all on Vercel" plan | Certain | Separate worker service on ECS Fargate from day one (**C6**). Never put queue consumption in a route handler. |
| **R3** | **Publishing double-post.** Facebook's `/feed` accepts no client idempotency key, so an ambiguous timeout is genuinely ambiguous. | High — visible client-facing failure | Medium | Deterministic BullMQ `jobId`; DB-level attempt state machine with an atomic claim; Redis lock per variant; and a **reconciliation read** of recent Page posts before any retry that follows a timeout. See `ARCHITECTURE.md`. |
| **R4** | **Page Insights metric deprecations.** `page_impressions` and `page_fans` were removed on 2025-11-15; a further wave (unique impressions, 3s video views, Reels unique impressions) landed 2026-06-15. Deprecated metrics now return an invalid-metric error. | High — analytics built on stale docs simply won't run | Certain (already happened) | Build against `page_media_view` / `post_media_view` / `page_follows` and the `views` metric. Treat the metric list as provider-versioned config, not hardcoded strings. Surface "not available" rather than zero (§18). |
| **R5** | **Prisma + serverless connection exhaustion.** Each Vercel function instance opens its own pool. | High | High | Mandatory pooler (RDS Proxy / PgBouncer transaction mode / Neon pooled endpoint); small `connection_limit`; long-running work belongs on ECS anyway. Depends on **Q3**. |
| **R6** | **Three-cloud surface: Vercel + AWS + Firebase/GCP.** Secret sprawl, three IAM models, three bills, three failure domains. | Medium | Certain (given §51) | Single secret source of truth; typed env validation at boot; document the trust boundaries in `SECURITY.md`; keep the Firebase dependency confined to one auth module so it stays replaceable. |
| **R7** | **Token invalidation.** Page tokens derived from a long-lived user token generally do not expire but *are* invalidated by password change, permission revocation, or app-permission review — silently. | Medium — silent publish failure | High | Scheduled health probe per account; `ProviderAuthenticationError` marks the account `NEEDS_RECONNECT`, pauses its queue, and notifies (§14, §20). |
| **R8** | **Edit/delete only applies to our own posts.** "An app can only update a Page post if the post was made using that app." | Medium — surprising UX | Certain | Capability-gate edit/delete on `createdByThisApp`; explain in the UI rather than failing at the API. |
| **R9** | **Timezone/DST correctness** in recurring queue slots (a 9am slot across a DST boundary). | Medium | Medium | Store slots as local wall-clock + IANA zone; resolve to UTC at enqueue time via a tz library; unit-test both DST transitions explicitly (§32). |
| **R10** | **Scope pressure from §41's definition of done.** Every feature carries UI states, authz, validation, tests, and docs. | Medium — schedule risk | High | Enforce P0/P1/P2 ruthlessly (`BUILD-PLAN.md`); resist adding providers before Facebook is fully done. |
| **R11** | **AI cost and prompt-injection via Brand Brain.** Brand context is user-authored text fed to Gemini; untrusted content (e.g. a repurposed article) can carry instructions. | Medium | Medium | Per-org usage metering and hard limits; treat all brand/source text as data, never instructions; never let AI output trigger a publish (§25); validate output against banned terms before display. |

---

## Estimated Complexity (SRS §47)

Estimates are **relative complexity plus indicative calendar time for a team of two senior
full-stack engineers**, and assume §41's definition of done is enforced. They exclude Meta App
Review wall-clock time (**R1**), which runs in parallel but can still gate the launch.

| Phase | Scope | Relative complexity | Indicative |
|-------|-------|--------------------|-----------|
| **Phase 0** — Foundation | Repo, CI, envs, Prisma baseline, Firebase auth + session cookies, tenancy primitives, RBAC engine, base UI system | 8 | 3–4 weeks |
| **Phase 1** — MVP publishing | Orgs/Workspaces/Brands, Facebook connect + token lifecycle, composer + capability validation, media upload, calendar + scheduling, queue + worker + idempotent publishing, publishing logs, minimal approval gate (**C4**), notifications core | 21 | 7–9 weeks |
| **Phase 2** — Agency operations | Full approval workflow, assignments, production tasks, client portal, asset library, collaboration/comments, notification breadth | 13 | 5–6 weeks |
| **Phase 3** — Intelligence | Analytics ingestion, dashboards, reporting, PDF/CSV export | 13 | 5–6 weeks |
| **Phase 4** — AI | Brand Brain, AI composer, repurposing, content planning, performance-informed suggestions | 8 | 3–4 weeks |

**Total to a genuinely production-ready v1: roughly 23–29 weeks (~6–7 months) at two senior
engineers**, plus design and QA capacity.

Assumptions affecting the estimate, per §47:

1. Two senior full-stack engineers, effectively full-time; no part-time context switching.
2. Facebook is the only provider through Phase 3. **Each additional provider is +2 to +3 complexity
   points (~1–1.5 weeks)** — TikTok and YouTube are the expensive ones (resumable/chunked upload,
   stricter review).
3. Design is delivered alongside, not ahead of, engineering; a design system exists by end of Phase 0.
4. Meta App Review approves within two rounds.
5. Answers to the P0 questions arrive before Phase 1 begins. Answering **Q1** or **Q4** late — after
   the schema is live — adds a data migration and roughly 1–2 weeks.
6. No white-labelling, no data-residency constraints, no bulk import (Q12/Q14/Q16 all "no").

Per §47: these are not compressed to look fast. The largest single lever on the timeline is
**cutting provider count and analytics depth**, not adding engineers.

---

## Related documents

- `ARCHITECTURE.md` — system, frontend, backend, queue, provider, AI, and storage architecture (§46.E)
- `DATABASE.md` — ERD, models, relationships, indexes, constraints (§46.F)
- `RBAC.md` — full permission matrix (§46.G, §5)
- `API.md` — initial API surface (§46.H)
- `SOCIAL_PROVIDERS.md` — verified capability matrix (§46.I)
- `BUILD-PLAN.md` — P0/P1/P2 classification and Phase 1 task breakdown (§46.J, §40)
- `DECISIONS.md` — decision log (§48)
