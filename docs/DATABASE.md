# AHN Orbit — Database Architecture

> Status: **proposed**. Answers SRS §46.F and §35. No migrations have been generated.
> PostgreSQL + Prisma. Last updated: 2026-08-11.

---

## 1. Tenant isolation strategy

Shared database, shared schema, **`organizationId` on every tenant-owned table** — including tables
where it is derivable through a parent (a `Comment` reaches an org via post → brand → workspace).
The denormalisation is intentional:

- isolation becomes one indexed predicate, identical on every table;
- RLS policies are uniform and cheap;
- no join is required to answer "may this request see this row?".

The cost is that `organizationId` must be written correctly on insert. That is enforced by the
tenant-scoped Prisma client, which supplies it — application code never sets it by hand.

**Two independent layers** (see `ARCHITECTURE.md` §4):

1. **Tenant-scoped Prisma client** (primary). A `$extends` wrapper injects `organizationId` into
   every `where` and `create`, and throws at runtime if a query on a tenant model somehow lacks it.
2. **Row-Level Security** (backstop). Every tenant table gets:
   ```sql
   ALTER TABLE "Post" ENABLE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON "Post"
     USING ("organizationId" = current_setting('app.current_org_id', true)::uuid);
   ```
   The client issues `SET LOCAL app.current_org_id = $1` inside the transaction it opens, which is
   compatible with PgBouncer transaction-mode pooling. The migration role bypasses RLS; the
   application role does not.

**Sub-tenant scoping.** `organizationId` stops cross-org access. Within an org, access to a specific
workspace or brand is decided by the RBAC engine against `WorkspaceMembership` /
`BrandAssignment` (see `RBAC.md`) and applied as additional query predicates — critically, for the
`Client` role, whose visibility is a strict subset of its own organization.

---

## 2. ERD

```
                                  ┌──────────────┐
                                  │     User     │ firebaseUid (unique)
                                  └──────┬───────┘
                     ┌───────────────────┼────────────────────┐
                     │                   │                    │
        ┌────────────▼─────────┐  ┌──────▼──────────┐  ┌──────▼─────────┐
        │OrganizationMembership│  │WorkspaceMembship│  │ BrandAssignment│
        └────────────┬─────────┘  └──────┬──────────┘  └──────┬─────────┘
                     │                   │                    │
        ┌────────────▼─────────┐         │                    │
        │    Organization      │◀────────┴────────────────────┘
        └───┬──────────────┬───┘
            │              │
   ┌────────▼──────┐  ┌────▼─────────┐   ┌──────────────┐   ┌──────────────┐
   │  Subscription │  │  Workspace   │   │   AuditLog   │   │ Notification │
   │  (1:1 w/ Org) │  │  (= Client)  │   └──────────────┘   └──────────────┘
   └───────────────┘  └────┬─────────┘
                           │
                  ┌────────▼────────┐         ┌───────────────┐
                  │      Brand      │────1:1──│  BrandVoice   │  (Brand Brain)
                  └───┬─────────┬───┘         └───────────────┘
                      │         │
        ┌─────────────▼──┐   ┌──▼─────────────┐   ┌─────────────┐
        │  SocialAccount │   │   MediaAsset   │   │ ContentIdea │
        └───┬────────┬───┘   └───────┬────────┘   └─────────────┘
            │        │               │
   ┌────────▼──┐  ┌──▼──────────┐    │
   │SocialCred │  │  QueueSlot  │    │
   │(encrypted)│  └─────────────┘    │
   └───────────┘                     │
                                     │
        ┌──────────┐                 │
        │   Post   │─────────────────┘   (via PostMedia)
        └────┬─────┘
             │ 1:N
   ┌─────────▼──────────┐
   │    PostVariant     │──── N:1 ──▶ SocialAccount
   └────┬───────────┬───┘
        │           │
 ┌──────▼──────┐ ┌──▼────────────────┐   ┌──────────────────┐
 │PublishingJob│ │   PostAnalytics   │   │AnalyticsSnapshot │ (account-level)
 └──────┬──────┘ └───────────────────┘   └──────────────────┘
        │ 1:N
 ┌──────▼───────────┐
 │PublishingAttempt │
 └──────────────────┘

 Post ─── 1:N ──▶ Approval · Comment · ProductionTask · PostMedia
```

---

## 3. Models

Conventions applied to every model: `id` is a **UUIDv7** (time-ordered, so it indexes like a serial
without leaking counts), `createdAt`/`updatedAt` are `timestamptz`, soft-deletable models carry
`deletedAt`, and every tenant model carries `organizationId`.

### 3.1 Identity & tenancy

**`User`** — app-owned identity record; Firebase owns credentials.
`id`, `firebaseUid` **unique**, `email` **unique** (citext), `name`, `avatarUrl`, `timezone`,
`locale`, `isPlatformAdmin` (bool, default false), `lastSeenAt`, `deletedAt`.
*Notes:* no password column — ever. `isPlatformAdmin` is the only role stored outside a membership
and is mirrored into a Firebase custom claim as a fast path (**C7**).

**`Organization`** — the tenant root. `id`, `name`, `slug` **unique**, `logoUrl`, `timezone`,
`settings` (jsonb), `deletedAt`.

**`OrganizationMembership`** — `id`, `organizationId`, `userId`, `role` (`OWNER | ADMIN |
ACCOUNT_MANAGER | CONTENT_CREATOR | APPROVER | CLIENT`), `status` (`INVITED | ACTIVE | SUSPENDED`),
`invitedById`, `invitedAt`, `acceptedAt`.
**Unique** `(organizationId, userId)`. A user may hold memberships in several organizations
(pending **Q7**).

**`Workspace`** — a client of the agency (**C1**). `id`, `organizationId`, `name`, `slug`,
`timezone` (IANA, required — §36), `clientCompanyName`, `status`, `deletedAt`.
**Unique** `(organizationId, slug)`.

**`WorkspaceMembership`** — `id`, `organizationId`, `workspaceId`, `userId`, `role`
(`MANAGER | CONTRIBUTOR | APPROVER | CLIENT_VIEWER | CLIENT_APPROVER`), `createdAt`.
**Unique** `(workspaceId, userId)`. This is what confines a Client to their own workspaces (§21).

**`Brand`** — `id`, `organizationId`, `workspaceId`, `name`, `slug`, `logoUrl`, `primaryColor`,
`website`, `deletedAt`. **Unique** `(workspaceId, slug)`.

**`BrandAssignment`** — optional narrowing below workspace level (§5: brand-level permissions).
`id`, `organizationId`, `brandId`, `userId`, `canApprove` (bool). **Unique** `(brandId, userId)`.
*Absence of rows for a brand means "workspace membership governs"* — this table only ever narrows.

### 3.2 Social

**`SocialAccount`** — `id`, `organizationId`, `workspaceId`, `brandId`, `platform` (enum),
`externalId` (the Page/account id at the provider), `handle`, `displayName`, `avatarUrl`,
`accountType` (e.g. `PAGE`), `status` (`ACTIVE | NEEDS_RECONNECT | DISABLED | REVOKED`),
`healthCheckedAt`, `healthError`, `scopes` (text[]), `connectedById`, `connectedAt`, `deletedAt`.
**Unique** `(organizationId, platform, externalId)` — the same Page cannot be connected twice within
one org, but *different* orgs may legitimately manage the same Page.

**`SocialCredential`** — separated so credentials are never selected accidentally by a
`SocialAccount` query. `id`, `organizationId`, `socialAccountId` **unique**,
`accessTokenCiphertext` (bytea), `refreshTokenCiphertext` (bytea), `iv`, `authTag`, `keyVersion`,
`expiresAt`, `refreshableUntil`, `lastRefreshedAt`, `scopes`.
*Notes:* AES-256-GCM, key from KMS/Secrets Manager, `keyVersion` present so keys can be rotated
without a migration (§6). Never exposed via any API, including admin (§28).

### 3.3 Content

**`Post`** — the master content item. `id`, `organizationId`, `workspaceId`, `brandId`,
`title`, `body` (master copy), `status` (§10 enum), `createdById`, `assignedToId`,
`approvalRequired` (bool), `scheduledFor` (nullable — the intent time; per-variant times may differ),
`timezone` (resolved at schedule time), `contentHash`, `source` (`MANUAL | AI_IDEA | REPURPOSE`),
`sourceIdeaId`, `publishedAt`, `deletedAt`.

`status`: `IDEA | DRAFT | INTERNAL_REVIEW | CLIENT_REVIEW | CHANGES_REQUESTED | APPROVED |
SCHEDULED | PUBLISHING | PUBLISHED | PARTIALLY_PUBLISHED | FAILED | CANCELED`.
*Addition to §10:* **`PARTIALLY_PUBLISHED`** — with N accounts per post, some can succeed while
others fail. Without it, a post with 1 of 3 targets failed is misrepresented by either `PUBLISHED`
or `FAILED`. Flagged for confirmation.

**`PostVariant`** — **the unit of publishing** (**C3**). `id`, `organizationId`, `postId`,
`socialAccountId`, `platform`, `body`, `firstComment`, `linkUrl`, `hashtags` (text[]),
`mentions` (jsonb), `platformOptions` (jsonb), `status` (variant-level), `scheduledFor`,
`claimedAt`, `claimToken`, `externalPostId`, `externalPermalink`, `publishedAt`, `lastError`
(jsonb), `contentHash`, `deletedAt`.
**Unique** `(postId, socialAccountId)`.
*Notes:* `claimedAt`/`claimToken` implement the atomic publish claim (`ARCHITECTURE.md` §5.2).
`contentHash` is the reconciliation fingerprint.

**`PostMedia`** — ordered join. `id`, `organizationId`, `postId`, `postVariantId` (nullable — null
means "applies to all variants"), `mediaAssetId`, `position`, `altText`.
**Unique** `(postVariantId, mediaAssetId, position)`.

**`MediaAsset`** — `id`, `organizationId`, `workspaceId`, `brandId` (nullable), `folderId`,
`kind` (`IMAGE | VIDEO | GIF`), `storageKey` **unique**, `mimeType` (verified server-side),
`sizeBytes`, `width`, `height`, `durationMs`, `checksum`, `originalFilename`, `tags` (text[]),
`uploadedById`, `status` (`PENDING | READY | REJECTED`), `rejectionReason`, `deletedAt`.
*Notes:* `mimeType` is the **sniffed** type, not the declared one (§17).

**`MediaFolder`** — `id`, `organizationId`, `workspaceId`, `parentId`, `name`.
**Unique** `(workspaceId, parentId, name)`.

### 3.4 Workflow

**`Approval`** — `id`, `organizationId`, `postId`, `stage` (`INTERNAL | CLIENT`),
`state` (`PENDING | APPROVED | CHANGES_REQUESTED | CANCELED`), `requestedById`, `requestedAt`,
`decidedById`, `decidedAt`, `comment`, `round` (int).
**Partial unique** on `(postId, stage)` where `state = 'PENDING'` — one open request per stage.

**`ProductionTask`** — the §11 pipeline (**C2**). `id`, `organizationId`, `postId`,
`stage` (`IDEA | COPYWRITING | DESIGN | INTERNAL_REVIEW | CLIENT_REVIEW | SCHEDULING`),
`state` (`TODO | IN_PROGRESS | BLOCKED | DONE`), `assigneeId`, `dueAt`, `blocking` (bool),
`startedAt`, `completedAt`. **Unique** `(postId, stage)`.

**`Comment`** — `id`, `organizationId`, `postId`, `postVariantId` (nullable), `parentId`,
`authorId`, `body`, `mentionedUserIds` (uuid[]), `visibility` (`INTERNAL | CLIENT_VISIBLE`),
`resolvedAt`, `resolvedById`, `deletedAt`.
*Notes:* `visibility` is what keeps internal chatter out of the client portal (§21) — enforced
server-side in the portal service, not by a frontend filter.

### 3.5 Scheduling & publishing

**`QueueSlot`** — configurable posting slots (§12). `id`, `organizationId`, `workspaceId`,
`socialAccountId` (nullable = applies to all accounts in the workspace), `dayOfWeek` (0–6),
`localTime` (`time`), `timezone`, `isActive`.
*Notes:* stored as **local wall-clock + IANA zone**, resolved to UTC at enqueue time. Storing UTC
here would break across DST (**R9**).

**`PublishingJob`** — the durable record of an intent to publish. `id`, `organizationId`,
`postVariantId`, `idempotencyKey` (text), `scheduledFor`, `state` (`PENDING | QUEUED | RUNNING |
SUCCEEDED | FAILED | CANCELED | DEAD_LETTER`), `attemptCount`, `maxAttempts`, `nextAttemptAt`,
`queueJobId`, `lastErrorCode`, `canceledAt`.
**Unique** `(postVariantId, idempotencyKey)`.

**`PublishingAttempt`** — one row per provider call, written **before** the call (§14).
`id`, `organizationId`, `publishingJobId`, `attemptNumber`, `state` (`IN_FLIGHT | SUCCEEDED |
FAILED | RECONCILED | INCONCLUSIVE`), `correlationId`, `startedAt`, `finishedAt`, `durationMs`,
`externalPostId`, `errorCode`, `errorMessage`, `errorRetryable`, `providerMeta` (jsonb, redacted),
`httpStatus`.
**Unique** `(publishingJobId, attemptNumber)`.
*Notes:* `providerMeta` stores only whitelisted safe fields — never tokens or full headers (§14, §33).

### 3.6 Analytics

**`PostAnalytics`** — per variant, per snapshot. `id`, `organizationId`, `postVariantId`,
`capturedAt`, `metrics` (jsonb), `availability` (jsonb: metric → `AVAILABLE | UNSUPPORTED |
DEPRECATED | ERROR`), `providerApiVersion`.
**Unique** `(postVariantId, capturedAt)`.
*Notes:* `availability` is how §18's "clearly indicate unavailable metrics" is honoured — a metric
Meta deprecated is recorded as deprecated, never as `0`.

**`AnalyticsSnapshot`** — per account, per day. `id`, `organizationId`, `socialAccountId`, `date`,
`metrics` (jsonb), `availability` (jsonb), `providerApiVersion`.
**Unique** `(socialAccountId, date)`.

*Why jsonb rather than columns:* providers expose genuinely different metric sets, and Meta's set is
actively churning (see `SOCIAL_PROVIDERS.md`). A normalised `metric_name/value` table was considered;
jsonb plus a typed accessor layer keeps reads cheap and avoids a migration every time a provider
adds a metric. Frequently-charted metrics get generated columns with indexes if profiling demands.

### 3.7 AI

**`BrandVoice`** (Brand Brain, §24) — 1:1 with Brand. `id`, `organizationId`, `brandId` **unique**,
`companyDescription`, `productsServices`, `targetAudience`, `brandVoice`, `tone`,
`preferredTerms` (text[]), `bannedTerms` (text[]), `ctas` (text[]), `website`,
`exampleContent` (jsonb), `socialInfo` (jsonb), `updatedById`.

**`ContentIdea`** (§25) — `id`, `organizationId`, `workspaceId`, `brandId`, `topic`, `hook`,
`platform`, `format`, `caption`, `cta`, `plannedFor`, `state` (`SUGGESTED | ACCEPTED | DISMISSED |
CONVERTED`), `convertedPostId`, `generatedById`, `generationId`.

**`AIUsage`** — `id`, `organizationId`, `userId`, `brandId`, `operation`, `model`, `inputTokens`,
`outputTokens`, `costEstimate`, `latencyMs`, `succeeded`, `createdAt`. Drives §38 plan limits and
cost visibility.

### 3.8 Platform

**`Notification`** — `id`, `organizationId`, `userId`, `type`, `title`, `body`, `resourceType`,
`resourceId`, `channel` (`IN_APP | EMAIL`), `readAt`, `emailedAt`, `createdAt`.

**`AuditLog`** — `id`, `organizationId`, `actorUserId` (nullable for system actions), `actorType`
(`USER | SYSTEM | WORKER`), `action`, `resourceType`, `resourceId`, `workspaceId`, `brandId`,
`before` (jsonb, redacted), `after` (jsonb, redacted), `ip`, `userAgent`, `correlationId`,
`createdAt`. **Append-only**: no update or delete grant for the application role.

**`Subscription`** (§38, Stripe-ready) — `id`, `organizationId` **unique**, `plan`,
`status` (`TRIALING | ACTIVE | PAST_DUE | CANCELED`), `stripeCustomerId`, `stripeSubscriptionId`,
`currentPeriodEnd`, `seats`, `limits` (jsonb: workspaces, socialAccounts, aiCreditsPerMonth,
storageBytes), `canceledAt`.

**`Invitation`** — `id`, `organizationId`, `email`, `role`, `workspaceIds` (uuid[]),
`tokenHash` **unique**, `expiresAt`, `acceptedAt`, `invitedById`.
*Notes:* only the **hash** of the invite token is stored; the token itself exists only in the email.

**`WebhookEvent`** — `id`, `provider`, `externalEventId`, `signatureValid`, `payload` (jsonb),
`processedAt`, `error`. **Unique** `(provider, externalEventId)` for webhook idempotency (§7).

---

## 4. Indexes

Beyond primary keys and the unique constraints listed above:

| Table | Index | Serves |
|---|---|---|
| every tenant table | `(organizationId)` | isolation predicate + RLS |
| `Post` | `(organizationId, workspaceId, status, scheduledFor)` | calendar & dashboard queries |
| `Post` | `(brandId, status) WHERE "deletedAt" IS NULL` | brand content lists |
| `Post` | `(assignedToId, status)` | "my work" views |
| `PostVariant` | `(status, scheduledFor) WHERE status = 'SCHEDULED'` | **the scheduler sweep** — partial, stays small |
| `PostVariant` | `(socialAccountId, publishedAt DESC)` | account timeline, reconciliation |
| `PostVariant` | `(externalPostId)` | webhook and analytics lookups |
| `PublishingJob` | `(state, nextAttemptAt) WHERE state IN ('PENDING','FAILED')` | retry sweep |
| `PublishingAttempt` | `(publishingJobId, attemptNumber DESC)` | log views |
| `MediaAsset` | `(organizationId, workspaceId, kind, createdAt DESC)` | library browsing |
| `MediaAsset` | GIN on `tags` | tag search |
| `MediaAsset` | GIN on `to_tsvector(originalFilename)` | filename search |
| `Comment` | `(postId, createdAt)` | thread rendering |
| `Approval` | `(postId, stage, state)` | approval queue |
| `Notification` | `(userId, readAt, createdAt DESC)` | notification bell |
| `AuditLog` | `(organizationId, createdAt DESC)`, `(resourceType, resourceId)` | audit views |
| `AnalyticsSnapshot` | `(socialAccountId, date DESC)` | charts |
| `PostAnalytics` | `(postVariantId, capturedAt DESC)` | post performance |
| `SocialAccount` | `(organizationId, status)` | account-health dashboard |
| `WorkspaceMembership` | `(userId)` | resolving a user's accessible workspaces on every request |

---

## 5. Constraints & integrity (§35)

### 5.1 Composite tenant foreign keys (decision D-015)

Every reference between two tenant-scoped tables is **composite**, carrying the tenant alongside
the child key:

```sql
ALTER TABLE "Post" ADD CONSTRAINT "Post_organizationId_brandId_fkey"
  FOREIGN KEY ("organizationId", "brandId")
  REFERENCES "Brand"("organizationId", "id")
  ON UPDATE CASCADE ON DELETE CASCADE;
```

Each parent therefore carries `@@unique([organizationId, id])` as the target. A row referencing a
parent in another organization is rejected by PostgreSQL itself — a single-column `brandId` key
would only have checked that the brand *exists*.

There are **34 such constraints**. Three consequences worth knowing:

1. **Optional references use `NO ACTION`, not `SET NULL`.** `SET NULL` on a composite key would try
   to null `organizationId`, which is `NOT NULL`. `NO ACTION` is evaluated at end-of-statement, so a
   cascading organization delete (parent and child removed together) still succeeds, while deleting
   a still-referenced brand or folder is refused. Affects `MediaAsset.brandId`/`.folderId`,
   `AIUsage.brandId`, `Post.sourceIdeaId`.
2. **Nested creates inherit the tenant.** Prisma now *rejects* an explicit `organizationId` in a
   nested create — it comes from the parent. Cross-tenant nesting is impossible by construction.
3. **`User` references cannot be composite.** A user spans organizations, so no `(organizationId, id)`
   key exists. `createdById`, `assignedToId`, `uploadedById` and friends stay application-enforced —
   the one residual gap, recorded in `DECISIONS.md`.

Enforcement is proven in `packages/db/src/composite-fk.integration.test.ts`, which bypasses the
tenant client *and* RLS (connecting as the table owner) so nothing but the foreign keys can catch
the write.

### 5.2 Other constraints

- **Foreign keys everywhere**, with `ON DELETE RESTRICT` on tenant parents (soft delete is the
  intended path) and `ON DELETE CASCADE` only on genuinely owned children (`PostMedia`,
  `PublishingAttempt`, `SocialCredential`).
- **Check constraints:** `PostVariant.scheduledFor IS NOT NULL WHEN status = 'SCHEDULED'`;
  `QueueSlot.dayOfWeek BETWEEN 0 AND 6`; non-negative sizes and counts;
  `Post.publishedAt IS NOT NULL WHEN status = 'PUBLISHED'`.
- **Partial uniques** for "one open X" semantics (`Approval`, above) rather than enforcing it in
  application code where a race can defeat it.
- **Enums in Postgres**, not free-text status columns.
- **Transactions** wrap: org creation + owner membership; post + variants + media; approval decision
  + status transition + audit + notification; publish claim + job + attempt.
- **The status transition table lives in `packages/core`** and is enforced server-side on every
  write (§10: "users must not be able to arbitrarily change status through API requests"). A
  transition not present in the table is rejected before it reaches the database.

---

## 6. Migration strategy

- Prisma Migrate, checked in, forward-only. Every migration reviewed for lock behaviour.
- **Expand → migrate → contract** for breaking changes: add nullable column, backfill in a
  `maintenance` job, switch reads, then drop.
- `CREATE INDEX CONCURRENTLY` for indexes on populated tables.
- Migrations run as a deploy step against the **direct** (non-pooled) connection string, gated on
  staging first; the worker is drained before migrations that alter publishing tables.
- Seed script provisions a demo org, workspace, brand, and a mock provider account for local
  development. **Mock providers exist only under `NODE_ENV !== 'production'`** (§42: never fake
  social API responses in production code).

---

## 7. Open schema questions

These block finalisation and map to `00-ANALYSIS.md` §D:

1. **Q1** — if a Client can span workspaces, a `Client` entity sits between `Organization` and
   `Workspace`, and `WorkspaceMembership` becomes `ClientMembership`. Cheap now, a migration later.
2. **Q4** — if approvals are deferred past MVP, `Approval` and `ProductionTask` still ship (schema
   only) so the status enum does not change under live data.
3. **`PARTIALLY_PUBLISHED`** — confirm this addition to the §10 enum.
4. **Q7** — if a user may not hold memberships in multiple organizations, `User.email` uniqueness
   and the invitation flow both simplify.
5. **Q3** — RLS requires a Postgres where we can create roles and policies; confirm the host.
