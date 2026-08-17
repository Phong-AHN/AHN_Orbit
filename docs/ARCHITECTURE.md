# AHN Orbit — Architecture Proposal

> Status: **proposed, pending confirmation of the P0 questions in `00-ANALYSIS.md`.**
> Answers SRS §46.E. Last updated: 2026-08-11.

---

## 1. System architecture

### 1.1 Deployment topology

The single most consequential constraint: **Vercel cannot host a BullMQ worker.** Vercel Functions
cap at 800s (1800s in beta) and are request-scoped; a BullMQ worker is a long-lived process holding a
blocking Redis connection. The §51 target of "Vercel + AWS" already implies the split, so we make it
explicit:

```
                        ┌───────────────────────────────┐
        Browser ───────▶│  Vercel — Next.js (App Router) │
                        │  • RSC pages, server actions   │
                        │  • /api route handlers          │
                        │  • auth session verification    │
                        │  • enqueue only (never consume) │
                        └───┬────────────┬───────────┬───┘
                            │            │           │
             ┌──────────────┘            │           └──────────────┐
             ▼                           ▼                          ▼
   ┌──────────────────┐        ┌──────────────────┐      ┌────────────────────┐
   │ PostgreSQL       │        │ Redis (Upstash)  │      │ AWS S3 + CloudFront │
   │ + pooler         │        │ • BullMQ queues  │      │ • media, exports    │
   │ (RDS/Neon/Prisma)│        │ • rate limits    │      │ • presigned URLs    │
   └──────▲───────────┘        │ • idem. locks    │      └─────────▲──────────┘
          │                    └────────▲─────────┘                │
          │                             │                          │
          │       ┌─────────────────────┴──────────────────────────┘
          │       │
   ┌──────┴───────┴───────────────────────────────────┐        ┌──────────────────┐
   │ AWS ECS Fargate — worker service (Node)          │───────▶│ Meta Graph API   │
   │  • publish · analytics · notify · health · maint │        │ Google Gemini    │
   │  • BullMQ Workers + repeatable schedulers         │───────▶│ Stripe · Sentry  │
   └───────────────────────────────────────────────────┘        └──────────────────┘

   Identity: Firebase Auth (GCP) ── ID token ──▶ Vercel ── session cookie ──▶ browser
```

**Rule enforced in code review:** the Next.js app *produces* jobs; it never *consumes* them. Queue
consumption exists only in the worker service.

### 1.2 Repository layout

A **pnpm monorepo**, because the web app and the worker must share the Prisma client, the provider
adapters, the RBAC engine, and the domain types — and duplicating any of those would violate §42.

```
ahn-orbit/
├── apps/
│   ├── web/                  # Next.js — UI, API routes, server actions
│   └── worker/               # Node service — BullMQ workers + schedulers (ECS)
├── packages/
│   ├── db/                   # Prisma schema, migrations, tenant-scoped client
│   ├── core/                 # domain: posts, scheduling, state machine, errors
│   ├── auth/                 # Firebase verification, session, TenantContext
│   ├── rbac/                 # permission definitions + policy engine
│   ├── notifications/        # types, copy, RBAC-aware fan-out (T1.15)
│   ├── providers/            # SocialProvider interface + FacebookProvider
│   ├── ai/                   # AIProvider interface + GeminiProvider
│   ├── storage/              # S3 client, presigning, key derivation
│   ├── queue/                # queue names, payload schemas, enqueue helpers
│   ├── contracts/            # zod schemas shared by client, server, worker
│   └── ui/                   # design system (shadcn/ui + tokens)
├── docs/
└── infra/                    # Dockerfile(s), ECS task defs, IaC
```

Domain boundaries inside `apps/web` follow §43 (`auth`, `organizations`, `workspaces`, `brands`,
`social`, `posts`, `composer`, `calendar`, `scheduling`, `publishing`, `approvals`, `comments`,
`media`, `analytics`, `notifications`, `ai`, `billing`, `admin`, `audit`) — as **feature folders**,
not a second layer of packages. §43 warns against over-complicated structures.

### 1.3 Request lifecycle

Every authenticated server entry point — route handler, server action, or RSC page — runs the same
four steps, in this order, with no exceptions:

```
1. authenticate   → verify session cookie (Firebase Admin) → User
2. resolve tenant → orgId/workspaceId/brandId from route or body → TenantContext
3. authorize      → rbac.assert(ctx, 'post:publish', resource) → throws 403
4. validate       → zod parse of input → typed payload
                  ↓
              domain service (tenant-scoped Prisma client)
```

Steps 1–3 are implemented once, in `packages/auth` + `packages/rbac`, and applied through a
`withAuth()` wrapper. A handler that does not use the wrapper cannot obtain a Prisma client — the
tenant-scoped client is only constructible from a `TenantContext`. This makes §4's "server-side
isolation" structurally hard to forget rather than a convention.

---

## 2. Frontend architecture

- **Next.js App Router + React Server Components + TypeScript.** Data fetching happens in server
  components against the tenant-scoped client; no data endpoint is called from the browser just to
  render a page.
- **Server Actions** for mutations, wrapped by the same `withAuth()` guard as route handlers. §5
  explicitly lists server actions as an enforcement point.
- **TanStack Query** only for genuinely client-interactive surfaces — the calendar's drag-and-drop,
  composer autosave, notification polling — where optimistic updates matter.
- **Tailwind CSS + shadcn/ui**, wrapped in `packages/ui` behind **design tokens** (§29). Application
  code consumes `Button`/`Card`/`DataTable`, never raw shadcn imports, so the system stays coherent
  (§29: "not a collection of disconnected pages").
- **`@orbit/core` must not be imported from a `'use client'` component.** The barrel re-exports
  `content-hash.ts`, which imports `node:crypto`, and webpack refuses to bundle that for the browser.
  Typecheck passes and `next build` fails — the same trap as the `.js` extension rule. Client
  components use platform primitives (`Date.now()` rather than `clock.now()`); server components and
  route handlers import core freely. Found in T1.15 by the production build, which is why the build
  is part of the per-task verification and not an afterthought.
- **Route groups mirror the audiences**, which is how the client portal stays leak-proof:

```
app/
├── (marketing)/                    # public
├── (auth)/                          # sign-in, reset, verify
├── (app)/[orgSlug]/                 # agency surface  — internal roles only
│   ├── dashboard · calendar · composer · posts · brands
│   ├── media · analytics · settings
├── (portal)/[orgSlug]/[workspaceSlug]/   # client surface — Client role only
│   └── calendar · approvals · published · analytics · assets
└── (admin)/                         # platform administrators only
```

  The layout of each group asserts the audience once, so a client user cannot land on an agency
  route even if they guess the URL — and §21's "no internal information leaks" is enforced by the
  fact that portal components query through a portal-scoped service with a narrower select set.
- **Required UI states are components, not ad-hoc markup**: `<Loading/>`, `<Empty/>`, `<ErrorState/>`,
  `<PermissionDenied/>`, `<Offline/>` (§29). A feature PR without them fails §41.
- **Accessibility**: semantic HTML, labelled controls, visible focus rings, keyboard-navigable
  calendar and composer, colour contrast checked in the token layer.

---

## 3. Backend architecture

Modular Next.js server, **not NestJS** — per §27's default. NestJS would add a second runtime,
second deployment target, and DI framework for no benefit at this size; the worker service is where
the genuinely non-HTTP work lives, and it is a plain Node process. If the API later needs to serve
third-party clients at high volume, extracting it is a contained change because domain logic already
lives in `packages/core`, not in route handlers.

**Layering** (§42: service layers where useful, no unnecessary abstraction):

```
route handler / server action     ← transport, zod validation, HTTP shape
        ↓
domain service (packages/core)    ← business rules, state machine, transactions
        ↓
tenant-scoped Prisma client       ← isolation guaranteed here
        ↓
PostgreSQL
```

Provider and AI calls are made **only** from domain services or workers, never from route handlers
directly.

**Error handling (§37).** One `AppError` base with a stable `code`, an HTTP status, a
`userMessage` (safe to display), and structured `context` (never rendered). Provider errors are
normalised by the adapter into the §37 taxonomy — `ProviderAuthenticationError`,
`ProviderRateLimitError`, `ProviderValidationError`, `ProviderMediaError`,
`ProviderPermissionError`, `ProviderUnavailableError`, `PublishingTimeoutError` — each carrying
`retryable: boolean` and an optional `retryAfter`, which is exactly what the retry policy needs.
The API error envelope is uniform (`API.md` §Errors).

**Authentication (§6, §51 — Firebase Auth).**

```
Browser: Firebase SDK sign-in (email/password | Google)  →  ID token
   ↓ POST /api/auth/session
Server:  Admin SDK verifyIdToken → createSessionCookie (14d) → HttpOnly, Secure,
         SameSite=Lax cookie; upsert User row keyed by firebaseUid
   ↓ every request
Server:  verifySessionCookie(checkRevoked: true) → uid → User + memberships (cached 30s)
```

Password reset, email verification, and Google sign-in are delegated to Firebase. Sign-out revokes
refresh tokens so the session cookie fails its revocation check immediately. Roles are **never** read
from the client or from the token (§5) — only from Postgres (**C7**).

**Rate limiting (§6, §34).** Redis-backed sliding window in Next.js middleware, keyed by
`userId` where authenticated and by IP otherwise, with tighter buckets on auth endpoints, AI
endpoints (also metered per org for billing), and publish-now.

**Audit (§16, §31).** Domain services emit audit events inside the same transaction as the change,
so the log cannot drift from reality. Reads are never audited; every write that crosses a permission
boundary is.

---

## 4. Database architecture

Full schema in `DATABASE.md`. Architectural stance:

- **PostgreSQL + Prisma** (§27, §35), single shared schema, tenant-discriminated.
- **Every tenant-owned table carries `organizationId`**, even where it is derivable through a parent.
  This is deliberate denormalisation: it makes isolation a single indexed predicate on every table
  and makes RLS policies uniform and cheap.
- **Two layers of isolation** (**C8**):
  1. *Primary* — a tenant-scoped Prisma client built via `$extends`, which injects
     `organizationId` into every `where` and rejects at runtime any model query lacking it.
  2. *Backstop* — Postgres RLS policies reading `current_setting('app.current_org_id')`, set with
     `SET LOCAL` inside the transaction the extension opens.
- **Connection pooling is mandatory** (**R5**): Vercel functions each hold their own pool. Use
  RDS Proxy / PgBouncer transaction mode / Neon's pooled endpoint with a low `connection_limit`,
  plus a direct URL for migrations.
- **Transactions** wrap every multi-row mutation (§35): publish claim, approval transitions,
  post + variants + media links, org creation with owner membership.
- **N+1 avoidance** (§35): list endpoints use explicit `select` + `include`, cursor pagination, and
  aggregate counts computed in one grouped query rather than per row.

---

## 5. Queue architecture

**Redis + BullMQ** (§13, §27). Workers run on ECS Fargate (**C6**, **R2**).

### 5.1 Queues

| Queue | Produced by | Concurrency | Purpose |
|---|---|---|---|
| `publish` | scheduler, publish-now | per-account limiter | Publish one `PostVariant` |
| `media` | upload completion | 5 | Probe/validate media, extract dimensions & duration |
| `analytics` | repeatable | 3 | Pull post/account metrics |
| `account-health` | repeatable (hourly) | 2 | Token validity & permission probe |
| `notifications` | domain events | 10 | In-app + email fan-out |
| `reports` | a person asking for one | 2 | Render a client report and store it |
| `maintenance` | repeatable | 1 | Retention (nightly), analytics rollup (hourly), cleanup |

A **repeatable scheduler job** runs every 30s, selects `PostVariant`s whose `scheduledFor <= now()`
and status is `SCHEDULED`, and enqueues them (**C10**, ±60s tolerance). Scheduling is *not* done with
one delayed BullMQ job per post: rescheduling and cancellation then become queue surgery, and the
database stops being the source of truth.

**Implemented in T1.11** (`packages/queue`, `apps/worker`). Every queue above is declared with a zod
payload schema in `queues.ts`; a payload that does not parse never reaches a processor, on either
side of the queue. The runtime plus the `maintenance` processor shipped there; `publish` landed with
T1.13, `account-health` with T1.7, `notifications` with T1.15, `analytics` with T3.1 and `reports`
with T3.5. `media` lands with its feature.

`reports` is the only queue a **person** produces to directly, and its payload is deliberately thin:
it names a `Report` row and nothing else. What the report covers lives in `Report.parameters`,
written when the request was authorised, so a job cannot widen its own scope by carrying different
arguments than the ones that were approved.

The `notifications` payload names a **subject**, never an audience — recipients are resolved by the
processor from live memberships and the real policy engine (**D-035**). It carries one identity
field, `actorUserId`, used solely to stop someone being told about their own action: it can remove a
recipient and never add one, which is why it is safe where a trusted `organizationId` would not be
(**D-037**).

The hourly health sweep runs as a **`maintenance` task** (`sweep-account-health`) rather than on the
`scheduler` queue: the scheduler queue exists to keep the 30-second publish sweep punctual (**D-025**),
and a pass across every account in the platform is exactly the work that would make it late. The
sweep only queries and enqueues; the provider calls happen on `account-health` at concurrency 2,
against their own rate-limit bucket (**D-031**).

Three things about the payloads are load-bearing:

- **No content.** A publish payload carries identifiers only, so a job queued before an edit cannot
  publish the stale copy, and post bodies never enter Redis.
- **No credentials.** Tokens are resolved at publish time through the encrypted store, never passed
  through a queue.
- **No trusted tenant.** The payload's `organizationId` is a *checked assertion*: the processor
  derives the real tenant from the subject row and a mismatch is a security event (decision **D-021**).

Retry policy is **not** delegated to BullMQ's `attempts`/`backoff` — see decision **D-020** for why
a rate limit and an ambiguous timeout cannot be expressed as an attempt count.

The web app may only produce. `@orbit/queue` splits into a producer and a consumer half, ESLint
refuses the consumer imports from `apps/web`, and `assertWorkerProcess()` throws unless
`ORBIT_ROLE=worker` (decision **D-022**).

### 5.2 Idempotency strategy (§13 — designed before implementation, as required)

Facebook's `/feed` endpoint accepts **no client-supplied idempotency key**, so a timeout is
genuinely ambiguous: the post may or may not exist. Four layers, in order:

1. **Deterministic job id.** `jobId = publish:{postVariantId}:{attemptEpoch}` — BullMQ silently drops
   a duplicate add with the same id, killing duplicate enqueues.
2. **Atomic claim in Postgres.** The worker's first action:
   ```sql
   UPDATE "PostVariant" SET status = 'PUBLISHING', "claimedAt" = now(), "claimToken" = $1
   WHERE id = $2 AND status = 'SCHEDULED'
   RETURNING id;
   ```
   Zero rows returned ⇒ someone else owns this publish ⇒ exit without calling the provider. This is
   the real guarantee; everything else is optimisation or recovery.
3. **Redis lock** on `lock:publish:{socialAccountId}` for the provider call, bounding concurrent
   in-flight calls per account and cooperating with provider rate limits.
4. **Reconciliation before retry.** A `PublishingAttempt` row is written with state `IN_FLIGHT`
   *before* the provider call, carrying a `correlationId`. If the call times out or the worker dies,
   the retry does **not** re-post. It first calls the provider's reconcile path — for Facebook, read
   recent posts on the Page (`/{page-id}/posts` filtered by `created_time` around the attempt window
   and matched on content hash) — and only publishes if no matching post exists. If reconciliation is
   itself inconclusive, the variant goes to `NEEDS_REVIEW` and a human decides. **Silently retrying
   an ambiguous publish is forbidden.**

**Implemented in T1.13** (`apps/worker/src/publishing/`). Each layer has its own module and its own
tests: `claim.ts` (layer 2), `attempts.ts` (layer 4's ledger), `engine.ts` (the sequence),
`rollup.ts` (partial publishing). The proofs that matter run against the mock provider's
`TIMEOUT_THEN_PUBLISHED` and `TIMEOUT_NOT_PUBLISHED` faults, plus three concurrent workers on one
variant.

One correction to the sketch above, found while building it: the **post** travels through
`PUBLISHING` as well as the variant. `SCHEDULED → PUBLISHED` is not a transition the machine has, so
the rollup had nowhere legal to go until `markPostPublishing` was added (decision **D-026**).

Retries: exponential backoff `30s → 2m → 8m → 30m` (max 4 attempts) for retryable errors only.
`ProviderRateLimitError` reschedules at `retryAfter` and does not consume an attempt.
`ProviderAuthenticationError` does not retry — it marks the account `NEEDS_RECONNECT`, pauses the
account's queue, and notifies (§14). Exhausted attempts land in a dead-letter set with the full
error chain, surfaced in the admin panel (§28) with a manual retry action (§13).

### 5.3 Provider rate limiting

A Redis token bucket per `(provider, accountId)` sized from the provider's published limits, checked
before each call. Meta's rate limits are dynamic and reported via the `X-App-Usage` /
`X-Business-Use-Case-Usage` response headers; the adapter parses them after every call and narrows
the bucket adaptively rather than relying on static constants.

---

## 6. Social provider architecture (§8)

The core publishing engine contains **zero** platform-specific code. It knows only this interface:

```ts
interface SocialProvider {
  readonly platform: Platform;
  capabilities(accountType?: string): PlatformCapabilities;

  // OAuth & lifecycle
  getAuthorizationUrl(input: AuthUrlInput): { url: string; state: string };
  exchangeCode(input: CallbackInput): Promise<ConnectedAccounts>;   // may return N accounts
  refreshCredential(cred: DecryptedCredential): Promise<DecryptedCredential>;
  probeHealth(cred: DecryptedCredential): Promise<AccountHealth>;   // token + scope validity
  revoke(cred: DecryptedCredential): Promise<void>;

  // Publishing
  validate(draft: VariantDraft): ValidationResult;                  // pure, no network
  publish(ctx: PublishContext): Promise<PublishResult>;
  reconcile(ctx: ReconcileContext): Promise<ReconcileResult>;       // ← added for idempotency
  getPostStatus(ref: ExternalPostRef): Promise<ExternalPostStatus>;
  deletePost(ref: ExternalPostRef): Promise<void>;

  // Analytics
  fetchPostAnalytics(ref: ExternalPostRef, range: DateRange): Promise<MetricSet>;
  fetchAccountAnalytics(ref: AccountRef, range: DateRange): Promise<MetricSet>;

  // Webhooks (where supported)
  verifyWebhook(req: RawRequest): boolean;
  parseWebhook(req: RawRequest): ProviderEvent[];
}
```

Two deliberate departures from the SRS's conceptual sketch (§8 permits improvement):

- **`reconcile()`** is added — without it, exactly-once publishing is not achievable against
  providers with no idempotency key (§5.2 above).
- **`validate()` is pure and synchronous**, separated from `publish()`, so the *same function* runs
  in the composer (instant client feedback) and again server-side before enqueue (§9: "the composer
  must use provider capabilities to determine validation"; §31: server-side validation).

`PlatformCapabilities` is a typed, versioned descriptor — max characters, media counts, accepted MIME
types, dimension and aspect-ratio bounds, video duration/size bounds, carousel support, scheduling
window, edit/delete support, available metrics. It is the **single source of truth** shared by
composer UI, server validation, and worker. Unsupported capabilities degrade gracefully and are
labelled in the UI (§7): the product never pretends a capability exists.

```
packages/providers/
├── types.ts            # SocialProvider, PlatformCapabilities, normalised errors
├── registry.ts         # platform → adapter; the only place platforms are enumerated
├── facebook/           # P0: adapter, capabilities, oauth, publish, insights, errors
└── {instagram,linkedin,x,tiktok,youtube,threads,pinterest}/   # P1–P2 stubs
```

Credentials: encrypted with AES-256-GCM using a key from AWS KMS/Secrets Manager, stored in
`SocialCredential` separate from `SocialAccount`, decrypted only inside the provider layer, and never
serialised into logs, API responses, or the admin panel (§6, §28, §33).

---

## 7. AI architecture (§23–25)

```ts
interface AIProvider {
  generateCaption(i: CaptionInput): Promise<AIResult<CaptionOutput>>;
  rewriteContent(i: RewriteInput): Promise<AIResult<string>>;      // shorten | expand | rephrase
  changeTone(i: ToneInput): Promise<AIResult<string>>;
  generateHashtags(i: HashtagInput): Promise<AIResult<string[]>>;
  generateCTA(i: CTAInput): Promise<AIResult<string[]>>;
  adaptForPlatform(i: AdaptInput): Promise<AIResult<string>>;
  generateIdeas(i: IdeaInput): Promise<AIResult<ContentIdea[]>>;
  repurposeContent(i: RepurposeInput): Promise<AIResult<ContentIdea[]>>;
  analyzeHistoricalPerformance(i: PerfInput): Promise<AIResult<PerformanceInsight[]>>;
}
```

`GeminiProvider` is the P0 implementation (§51). Business logic depends on the interface only (§23),
and the model id is configuration, never a literal in a service.

**Brand Brain grounding and isolation (§24).** The client sends a `brandId` and an intent — never
brand context. The server loads that brand's `BrandVoice` (after an RBAC check), assembles the
prompt, and calls the model. Brand context is injected as clearly delimited **data**, never as
instructions, and the assembler is hard-scoped to a single brand id per call, so one brand's private
context cannot reach another's generation. Source material for repurposing (an article, a
newsletter) is likewise treated as untrusted data (**R11**).

**Output handling.** Every result returns as a **suggestion**: `AIResult` carries the text, the model
id, token usage, and a `bannedTermHits` array checked against the brand's banned terms. Nothing is
written to a post without a user action, and **AI can never trigger publishing** (§25). Structured
outputs (ideas, hashtags) are validated against a zod schema; a malformed response is a normal
error, not a crash.

**Cost control.** Every call is metered per organization against a plan limit (§38) and recorded in
`AIUsage`. Long generations (monthly planning) run as `ai` queue jobs on the worker rather than in a
request.

---

## 8. Storage architecture (§17)

- **AWS S3** (§51), one bucket per environment, **all public access blocked**.
- **Key derivation encodes the tenant**, which makes isolation auditable from the key alone:
  `org/{orgId}/workspace/{workspaceId}/brand/{brandId}/{yyyy}/{mm}/{assetId}/{variant}.{ext}`
  Filenames are never taken from user input — the object key is derived from a generated `assetId`
  plus a validated extension, which is what prevents path traversal and disguised executables.
- **Upload flow:** client requests a presigned `PUT` (server checks RBAC, declared MIME, declared
  size against plan limits) → browser uploads directly to S3 → client confirms → a `media` job
  **verifies the actual bytes server-side** (magic-number sniff, real dimensions, duration) and
  rejects anything whose true type disagrees with the declared one. Client-declared MIME is never
  trusted (§17).
- **Reads** go through short-lived presigned `GET` URLs (default 15 min) issued only after an RBAC
  check, or through CloudFront with signed URLs for hot assets. Client-portal users get URLs for
  assets in their workspace only.
- **Retention:** soft-deleted assets are purged from S3 by the nightly `maintenance` job after a
  30-day grace period; S3 versioning plus lifecycle rules guard against accidental loss.

---

## 9. Observability (§33)

- **Structured JSON logging** with a per-request `correlationId` propagated into queue payloads, so
  a publish can be traced browser → API → queue → worker → provider in one query.
- **Sentry** on the web app and the worker, sharing release tags.
- A **redaction layer in the logger** strips `token`, `secret`, `password`, `authorization`,
  `client_secret`, and the credential fields by key name — §33's "never log secrets" enforced by
  code, not discipline.
- Metrics that matter operationally: publish success rate per provider, publish latency,
  queue depth and age, retry and DLQ counts, provider error rate by normalised code, token-health
  failures, AI spend per org.
- `/api/health` (liveness) and `/api/health/deep` (DB, Redis, S3, provider reachability) feed the
  admin panel's API-health view (§28).

---

## 10. Environments & configuration (§45)

Three environments — `development`, `staging`, `production` — each with its own Firebase project, S3
bucket, database, Redis, and **Meta app** (a Test App in dev/staging; the reviewed app only in
production). Environment variables are validated by a zod schema at process boot in both apps, so a
missing secret fails the deploy rather than the first request that needs it. Secrets live in Vercel
Environment Variables and AWS Secrets Manager; `.env.example` is committed, real values never are.

---

## 11. What we deliberately did not build

Per §52 ("when a simpler architecture is sufficient, prefer the simpler architecture") and §42
("create unnecessary abstractions" — do not):

- **No NestJS** (§27 default; no second runtime for this size).
- **No microservices.** One web app, one worker service. Domain boundaries are packages, not network
  hops.
- **No event bus / CQRS / event sourcing.** The audit log gives us history; Postgres transactions
  give us consistency.
- **No GraphQL.** REST + server actions + zod contracts cover the surface, and §34 asks for
  conventional pagination/filtering/sorting.
- **No per-tenant database or schema.** A shared schema with a discriminator plus RLS meets §4 at
  this scale; per-tenant databases are a migration and ops burden we do not need at ~100 orgs.
- **No self-hosted Redis, Postgres, or object store.** Managed everywhere.
