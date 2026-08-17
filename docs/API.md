# AHN Orbit — Initial API Surface

> Status: **proposed**. Answers SRS §46.H and §34. Nothing is implemented.
> Last updated: 2026-08-11.

---

## 1. Conventions (§34)

| Aspect | Decision |
|---|---|
| Base path | `/api/v1` |
| Transport | REST over HTTPS. Server Actions handle first-party mutations; every action is wrapped by the same guard as a route handler and is treated as a public endpoint. |
| Tenancy | Organization comes from the **session + path** (`/api/v1/orgs/{orgId}/…`), never from a header or body. A body-supplied `organizationId` is ignored, and its presence is logged as suspicious. |
| Auth | HttpOnly session cookie, verified by Firebase Admin with `checkRevoked: true`. |
| Content type | `application/json`; file bytes go to S3 directly via presigned URLs, never through the API. |
| Validation | zod schemas in `packages/contracts`, shared verbatim by client, server, and worker. |
| IDs | UUIDv7 strings. |
| Timestamps | ISO 8601 **UTC** in every payload. Localisation is a rendering concern (§36). |
| Casing | `camelCase` throughout. |
| Idempotency | `Idempotency-Key` header accepted on `POST` for publish-now, retry, and report generation. |
| Versioning | Path-versioned. Breaking changes require `/v2`. |

### Pagination

Cursor-based; offsets do not survive a live calendar.

```
GET /api/v1/orgs/{orgId}/posts?limit=25&cursor=eyJpZCI6…&sort=-scheduledFor

{ "data": [ … ], "pageInfo": { "nextCursor": "…", "hasNextPage": true }, "meta": { "totalCount": 412 } }
```

`totalCount` is returned only where it is cheap; expensive counts are omitted rather than made slow.

### Filtering & sorting

Filters are explicit named query params — never a free-form query language.
`?status=SCHEDULED,APPROVED&workspaceId=…&brandId=…&socialAccountId=…&platform=FACEBOOK&createdById=…&from=…&to=…`
Sort: `?sort=-scheduledFor` (`-` = descending). Only whitelisted fields are sortable.

### Error envelope (§34, §37)

```json
{
  "error": {
    "code": "PROVIDER_RATE_LIMIT",
    "message": "Facebook is temporarily limiting requests for this Page. We'll retry automatically.",
    "details": [{ "field": "body", "issue": "exceeds 63206 characters" }],
    "retryable": true,
    "retryAfter": 900,
    "correlationId": "01J8Z…"
  }
}
```

`message` is safe to display verbatim (§37). Internal detail — stack traces, provider payloads,
SQL — never crosses this boundary; it goes to the structured log under the same `correlationId`.

| HTTP | When |
|---|---|
| 200 / 201 / 204 | Success |
| 400 `VALIDATION_ERROR` | Schema or business-rule violation |
| 401 `UNAUTHENTICATED` | Missing/invalid/revoked session |
| 403 `FORBIDDEN` | Authenticated, lacks the permission |
| 404 `NOT_FOUND` | Missing **or** in another tenant — deliberately indistinguishable |
| 409 `CONFLICT` | Illegal state transition, duplicate connection, concurrent edit |
| 413 `PAYLOAD_TOO_LARGE` | Upload exceeds plan or platform limits |
| 422 `PROVIDER_VALIDATION_ERROR` | Content invalid for the target platform |
| 429 `RATE_LIMITED` | Our limiter or the provider's; `Retry-After` set |
| 500 `INTERNAL_ERROR` | Unexpected; `correlationId` returned for support |
| 503 `PROVIDER_UNAVAILABLE` | Upstream down |

**Cross-tenant access returns `404`, never `403`** — a `403` would confirm the resource exists.

### Rate limits

Redis sliding window, keyed by user (or IP when unauthenticated). Every response carries
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

| Bucket | Limit |
|---|---|
| Auth (`/auth/*`) | 10 / min / IP |
| General authenticated | 300 / min / user |
| AI generation | 20 / min / user, **and** a monthly org credit limit (§38) |
| Publish now | 30 / min / org |
| Media presign | 60 / min / user |

---

## 2. Endpoints

### 2.1 Auth (§6)

| Method | Path | Permission | Notes |
|---|---|---|---|
| `POST` | `/auth/session` | public | Body `{ idToken }` from Firebase. Verifies, mints the session cookie, upserts the `User`. |
| `DELETE` | `/auth/session` | authenticated | Clears the cookie and revokes Firebase refresh tokens. |
| `GET` | `/auth/me` | authenticated | Current user + memberships + effective permissions (drives the frontend's `useCan`). |
| `PATCH` | `/auth/me` | authenticated | Name, avatar, timezone, locale, notification prefs. |
| `POST` | `/auth/accept-invitation` | authenticated | Body `{ token }`. Consumes an `Invitation` by token hash. |

Password reset, email verification, and Google sign-in run entirely through the Firebase client SDK;
AHN Orbit exposes no password endpoint and stores no password material.

### 2.2 Organizations & members

| Method | Path | Permission |
|---|---|---|
| `GET` | `/orgs` | authenticated — orgs the caller belongs to |
| `POST` | `/orgs` | authenticated — creator becomes `OWNER` |
| `GET` | `/orgs/{orgId}` | `org:read` |
| `PATCH` | `/orgs/{orgId}` | `org:update` |
| `DELETE` | `/orgs/{orgId}` | `org:delete` (soft) |
| `GET` | `/orgs/{orgId}/members` | `member:list` |
| `POST` | `/orgs/{orgId}/members/invitations` | `member:invite` |
| `DELETE` | `/orgs/{orgId}/members/invitations/{id}` | `member:invite` |
| `PATCH` | `/orgs/{orgId}/members/{userId}` | `member:update_role` |
| `DELETE` | `/orgs/{orgId}/members/{userId}` | `member:remove` |
| `GET` | `/orgs/{orgId}/audit-logs` | `audit:read` |
| `GET` | `/orgs/{orgId}/dashboard` | `org:read` — see below |

**The dashboard** (§20, T1.17) returns per-client status counts, ranked alerts, account health and
the next scheduled post. Gated on `org:read` rather than `post:read`, because `post:read` is
workspace- or brand-scoped for every role below Admin and would deny a Content Creator an overview
for want of the workspace id the overview exists to summarise (**D-041**). The permission opens the
page; the contents are narrowed by `accessibleWorkspaceIds`, and the account-health section is
additionally gated on `social_account:read` and **omitted** rather than zeroed when absent.

Every figure comes from a fixed number of grouped queries — the cost does not scale with the number
of clients, accounts or posts (**D-042**).

### 2.3 Workspaces & brands

| Method | Path | Permission |
|---|---|---|
| `GET` `POST` | `/orgs/{orgId}/workspaces` | `workspace:read` / `workspace:create` |
| `GET` `PATCH` `DELETE` | `/orgs/{orgId}/workspaces/{wsId}` | `workspace:read` / `:update` / `:delete` |
| `GET` `POST` `DELETE` | `/orgs/{orgId}/workspaces/{wsId}/members[/{userId}]` | `workspace:manage_members` |
| `GET` `POST` | `/orgs/{orgId}/workspaces/{wsId}/brands` | `brand:read` / `brand:create` |
| `GET` `PATCH` `DELETE` | `/orgs/{orgId}/brands/{brandId}` | `brand:read` / `:update` / `:delete` |
| `GET` `PUT` | `/orgs/{orgId}/brands/{brandId}/voice` | `brand_voice:read` / `:update` — Brand Brain (§24) |
| `GET` `POST` | `/orgs/{orgId}/queue-slots?workspaceId=` | `post:read` / `post:schedule` — §7 posting slots (**D-083**) |
| `PATCH` `DELETE` | `/orgs/{orgId}/queue-slots/{id}` | `post:schedule` — `PATCH` pauses or resumes; deleting moves nothing already scheduled |

### 2.4 Social accounts (§7)

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/orgs/{orgId}/social-accounts` | `social_account:read` | Filter by workspace, brand, platform, status |
| `POST` | `/orgs/{orgId}/social-accounts/oauth/{platform}/start` | `social_account:connect` | Returns the authorization URL; **`state` is signed, single-use, TTL 10 min, and bound to the session** (§6) |
| `GET` | `/social/oauth/{platform}/callback` | signed state | Provider redirect target. Validates `state`, exchanges the code, returns the list of connectable accounts (a Meta user often admins many Pages) |
| `POST` | `/orgs/{orgId}/social-accounts` | `social_account:connect` | Confirms which discovered accounts to connect, and to which brand |
| `POST` | `/orgs/{orgId}/social-accounts/{id}/reconnect` | `social_account:reconnect` | Restarts OAuth for an existing account. Platform, workspace and brand come from the **account row**, never the body — the only accepted field is a relative `returnTo`. Reuses the same signed, single-use `state`; the callback cannot tell a reconnect from a first connection |
| `DELETE` | `/orgs/{orgId}/social-accounts/{id}` | `social_account:disconnect` | Revokes at the provider where supported, then soft-deletes |
| `GET` | `/orgs/{orgId}/social-accounts/{id}/health` | `social_account:read` | Probes the platform and records the verdict. Probe-driven, not expiry-driven (`SOCIAL_PROVIDERS.md` §4). A transient outage surfaces as the error it is rather than demoting the account; only an auth or permission failure does that |
| `GET` | `/orgs/{orgId}/social-accounts/{id}/capabilities` | `social_account:read` | The `PlatformCapabilities` descriptor that drives composer validation |

**No endpoint returns token material, in any form, to any role.**

### 2.5 Posts & composer (§9, §10)

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/orgs/{orgId}/posts` | `post:read` | The calendar/list workhorse; all §12 filters |
| `POST` | `/orgs/{orgId}/posts` | `post:create` | Creates post + variants in one transaction |
| `GET` `PATCH` `DELETE` | `/orgs/{orgId}/posts/{id}` | `post:read` / `:update` / `:delete` | `PATCH` rejects edits at/after `APPROVED` (409) |
| `POST` | `/orgs/{orgId}/posts/{id}/duplicate` | `post:create` | |
| `POST` | `/orgs/{orgId}/posts/{id}/autosave` | `post:update` | Debounced; returns a version token for conflict detection |
| `POST` | `/orgs/{orgId}/posts/{id}/validate` | `post:read` | **Server-side** capability validation for all variants — the composer's source of truth |
| `POST` | `/orgs/{orgId}/posts/{id}/preview` | `post:read` | Normalised per-platform preview payload |
| `PATCH` | `/orgs/{orgId}/posts/{id}/variants/{variantId}` | `post:update` | Per-account content overrides; `null` clears one and re-inherits |
| `POST` | `/orgs/{orgId}/posts/{id}/assign` | `post:assign` | |
| `POST` | `/orgs/{orgId}/posts/{id}/transition` | per §5 transition table | **The only way status changes.** Body `{ to, comment? }`; illegal transition ⇒ 409 |
| `POST` | `/orgs/{orgId}/posts/{id}/schedule` | `post:schedule` | Body `{ localTime }`, `{ useNextQueueSlot: true }` or `{ scheduledForUtc }` — exactly one |
| `PATCH` | `/orgs/{orgId}/posts/{id}/schedule` | `post:reschedule` | Move an already-scheduled post; the drag-and-drop path |
| `DELETE` | `/orgs/{orgId}/posts/{id}/schedule` | per the transition table | Unschedule back to `DRAFT`; voids approvals |
| `GET` | `/orgs/{orgId}/calendar` | `post:read` | `from`, `to`, `timeZone` (display only), plus §12 filters |
| `POST` | `/orgs/{orgId}/posts/{id}/publish-now` | `post:publish_now` | Scheduling for the present — same key, same job row (**D-028**) |
| `POST` | `/orgs/{orgId}/posts/{id}/retry` | `post:retry_failed` | Retries `FAILED` accounts only; never a published or parked one |
| `GET` | `/orgs/{orgId}/posts/{id}/publishing` | `post:read` | Per-account state and the attempt timeline |
| `POST` | `/orgs/{orgId}/posts/{id}/cancel` | `post:cancel_scheduled` | |
| `GET` | `/orgs/{orgId}/posts/{id}/activity` | `post:read` | Merged approvals, comments, transitions, publish attempts |

A dedicated `/transition` endpoint exists so that status is **never** a writable field on `PATCH`.
That is what §10's "users must not be able to arbitrarily change status" requires structurally.

**Implemented in T1.9:** list, create, get, patch, delete, `duplicate`, `autosave`,
`validate`, `assign`, `transition`, and `variants/{variantId}`.
**Added in T1.12:** `schedule` (POST/PATCH/DELETE) and `/calendar`. Still to come:
`preview` (T1.9 follow-up), `publish-now` and `cancel` (T1.13), `activity` (T1.14).

On scheduling: the body says *when* in local terms, never in what zone —
the **workspace's** zone decides what a wall time means (assumption C5), and it is
resolved server-side. `timeZone` on `/calendar` is the opposite: display only,
deciding which posts fall in the viewer's "June". A wall time that does not exist
(spring-forward gap) is a `400`; one that happens twice takes the earlier instant.
See **D-023**.

`/transition` declares no permission of its own. Which permission applies depends on
*which* transition was requested, so the state machine names it and the RBAC layer
enforces it — naming one at the route would be wrong for most transitions and too
broad for the rest.

The write schemas omit `status`, `createdById`, `organizationId`, `publishedAt`,
`contentHash`, `externalPostId`, `externalPermalink`, `claimToken`, `claimedAt` and
`lastError` entirely, and supplying any of them is a logged `400` rather than a silent
strip — so a probe is visible rather than merely ineffective.

### 2.6 Approvals (§15) & collaboration (§16)

| Method | Path | Permission |
|---|---|---|
| `GET` | `/orgs/{orgId}/approvals?stage=CLIENT&state=PENDING` | `post:read` — the approval queue |
| `GET` | `/orgs/{orgId}/posts/{id}/approvals` | `post:read` — the post's review history |
| `POST` | `/orgs/{orgId}/approvals/{id}/decide` | per the transition the decision implies — body `{ decision, comment?, onBehalfOf?, reason? }` |
| `GET` `POST` | `/orgs/{orgId}/posts/{id}/comments` | `post:read` / `comment:create` — `visibility` respected server-side |
| `PATCH` `DELETE` | `/orgs/{orgId}/comments/{id}` | `comment:create` + author check |
| `POST` | `/orgs/{orgId}/comments/{id}/resolve` | `comment:resolve` |
| `GET` `POST` `PATCH` | `/orgs/{orgId}/posts/{id}/tasks[/{taskId}]` | `post:assign` — §11 production stages |

**Implemented in T1.10:** the queue, the per-post history, `decide`, and the full
comment surface. `tasks` remains schema-only (P1).

There is deliberately **no** `POST /posts/{id}/approvals`. A review is requested by
moving the post into a review status, and `transitionPost` opens the gate in the same
transaction — an endpoint that created approval rows directly would be a way to queue
a review the state machine never agreed to.

`decide` declares no permission of its own, for the same reason `/transition` does not:
`post:approve_internal`, `post:submit_client_review`, `post:approve_client` and
`post:request_changes` are four different rights, and which one applies depends on the
gate, the decision, and whether the post needs client sign-off. The decision is
recorded inside the transition's transaction, so it commits with the status change or
not at all.

`onBehalfOf` records a client's decision relayed by phone or email (docs/RBAC.md
note 5). It requires `reason`, is refused for a Client and on an internal gate, is
stored on the row, and is audited as `approval.approved_on_behalf_of` plus a
`securityEvent` log line.

### 2.7 Media (§17)

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/orgs/{orgId}/media` | `media:read` | Filter by workspace, brand, kind, tags, folder; search |
| `POST` | `/orgs/{orgId}/media/presign` | `media:upload` | Checks declared MIME/size against plan and platform limits; returns a presigned `PUT` and an `assetId` |
| `POST` | `/orgs/{orgId}/media/{assetId}/complete` | `media:upload` | Enqueues server-side verification of the **actual bytes**; asset stays `PENDING` until it passes |
| `GET` | `/orgs/{orgId}/media/{assetId}` | `media:read` | Metadata + short-lived signed `GET` URL |
| `PATCH` `DELETE` | `/orgs/{orgId}/media/{assetId}` | `media:update` / `:delete` | |
| `GET` | `/orgs/{orgId}/media/folders?workspaceId` | `media:read` | ✅ |
| `POST` | `/orgs/{orgId}/media/folders` | `media:upload` | ✅ Optional `parentId`, 5 levels deep |
| `PATCH` | `/orgs/{orgId}/media/folders/{id}` | `media:update` | ✅ Rename |
| `DELETE` | `/orgs/{orgId}/media/folders/{id}` | **`media:update`** | ✅ The folder goes; contents move up. **Nothing is deleted** (**D-081**) |
| `POST` | `/orgs/{orgId}/media/move` | `media:update` | ✅ Returns how many actually moved |

Folders are scoped to a **workspace**, not a brand — agencies file by campaign and by shoot, and
both span the brands belonging to one client. An asset from another workspace is silently not moved,
so `moved` can be lower than the number asked for. `GET /media` accepts `folderId`: omitted means
anywhere, present means that folder, and `workspaceId` alone means the root specifically.

### 2.8 Publishing & logs (§14)

| Method | Path | Permission |
|---|---|---|
| `GET` | `/orgs/{orgId}/publishing/jobs` | `post:read` — filter by state, account, date |
| `GET` | `/orgs/{orgId}/publishing/jobs/{id}` | `post:read` — includes the full attempt chain |
| `POST` | `/orgs/{orgId}/publishing/jobs/{id}/retry` | `post:retry_failed` — accepts `Idempotency-Key` |
| `POST` | `/orgs/{orgId}/publishing/jobs/{id}/cancel` | `post:cancel_scheduled` |

| `GET` | `/orgs/{orgId}/publishing/needs-review` | `post:read` — publishes parked awaiting a decision |
| `POST` | `/orgs/{orgId}/publishing/variants/{id}/resolve` | `post:retry_failed` — body `{ resolution, reason, externalPostId? }` |

Attempt payloads expose normalised error code, human message, retry count, and whitelisted provider
metadata — never credentials or raw provider responses (§14, §33).

**Implemented in T1.14:** the job list (cursor-paginated, filterable by state, workspace, brand,
account and date), job detail with the full attempt chain, the needs-review queue, per-job retry, and
resolution of a parked publish.

`/resolve` is the only place a person writes a publishing outcome. It exists because an ambiguous
timeout parks a variant and nothing automated will touch it again (**D-027**); without it, a parked
publish would wait forever. All three answers require a `reason`, are audited, and `PUBLISHED`
additionally requires the external post id (**D-029**, **D-030**). Choosing "it did not publish"
returns the variant to the engine rather than publishing from here, so all four idempotency layers
apply to the next attempt.

`/jobs/{id}/retry` refuses a parked variant outright — retrying on an unknown outcome is exactly the
guess the design forbids.

### 2.9 Analytics & reporting (§18, §19)

| Method | Path | Permission |
|---|---|---|
| `GET` | `/orgs/{orgId}/analytics/accounts/{accountId}?from&to&compareTo` | `analytics:read` |
| `GET` | `/orgs/{orgId}/analytics/posts?from&to&brandId&platform&sort=-engagementRate` | `analytics:read` |
| `GET` | `/orgs/{orgId}/analytics/overview?workspaceId&from&to` | `analytics:read` |
| `GET` | `/orgs/{orgId}/reports` | `report:generate` — the organization's reports |
| `POST` | `/orgs/{orgId}/reports` | `report:generate` — async; returns a queued report |
| `GET` | `/orgs/{orgId}/reports/{id}` | `report:generate` — status only |
| `GET` | `/orgs/{orgId}/reports/{id}/download` | **`report:export`** — a 5-minute signed URL |

Download is a separate route on a separate permission, and **no response on any of these carries a
storage key** — the service's select omits it entirely (**D-060**). Generating a document and
handing the file to somebody are different acts, which is why the matrix has always had two rights.

Every analytics response carries an `availability` map alongside `metrics`, so the UI can render
"not provided by Facebook" instead of a misleading zero (§18, `SOCIAL_PROVIDERS.md` §3).

### 2.10 AI (§23–25)

| Method | Path | Permission | Notes |
|---|---|---|---|
| `POST` | `/orgs/{orgId}/ai/caption` | `ai:generate` | ✅ Body carries `brandId` + intent — **never brand context**; the server loads it (§24) |
| `POST` | `/orgs/{orgId}/ai/rewrite` | `ai:generate` | ✅ `mode: shorten \| expand \| rephrase \| tone` |
| `POST` | `/orgs/{orgId}/ai/hashtags` | `ai:generate` | ✅ |
| `POST` | `/orgs/{orgId}/ai/cta` | `ai:generate` | Not implemented (Phase 4 P2) |
| `POST` | `/orgs/{orgId}/ai/ideas` | `ai:generate` | Async for monthly plans; returns a `generationId` |
| `POST` | `/orgs/{orgId}/ai/repurpose` | `ai:generate` | ✅ Source text treated strictly as data (R11). Length cap and link support come from the target's capability descriptor, never the body (**D-079**) |
| `GET` | `/orgs/{orgId}/ai/generations/{id}` | `ai:generate` | Poll async results |
| `GET` `POST` | `/orgs/{orgId}/content-ideas` | `post:read` / `post:create` | ✅ Filters: `workspaceId`, `brandId`, `state`, `q` |
| `GET` `PATCH` | `/orgs/{orgId}/content-ideas/{id}` | `post:read` / `post:update` | ✅ `state` accepts SUGGESTED · ACCEPTED · DISMISSED — **not** CONVERTED |
| `POST` | `/orgs/{orgId}/content-ideas/{id}/convert` | `post:create` | ✅ Creates a **DRAFT** post, once. A second attempt is a 409 (**D-076**) |
| `GET` | `/orgs/{orgId}/ai/usage` | `ai:view_usage` | ✅ Credits consumed vs. plan limit. **One request = one credit** (**D-066**) |

Every AI response is a **suggestion object** — text plus model id and `bannedTermHits`. No AI
endpoint writes to a post, and none can trigger publishing (§25).

`bannedTermHits` is a **warning, never a rejection** (**D-067**): the suggestion is returned either
way and the surface names the words. Rows marked ✅ are implemented; the rest are Phase 4 P2.

Brand context is never accepted from a request body. The body names a `brandId`; the server loads
that brand's material and fences it as data (**D-065**, §24).

### 2.11 Notifications (§22)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/orgs/{orgId}/notifications?unread=true&before=&limit=` | Returns `{ notifications, nextCursor, unread }` |
| `POST` | `/orgs/{orgId}/notifications/{id}/read` | 404 for a notification that is not yours |
| `POST` | `/orgs/{orgId}/notifications/read-all` | |
| `GET` `PATCH` | `/me/notification-preferences` | **Not built** — arrives with email (**D-034**) |

**These routes carry no `permission`, and that is the design.** There is no
`notification:read` grant and there should not be one: reading notifications is
not a role's right but an identity's. An Owner can see every post in the
organization and still cannot see what an Account Manager was told. Every query
narrows on the **session principal's** user id, so another person's row matches
nothing — a 404, never a 403 that would confirm it exists. `withAuth` still runs
authentication and tenant resolution first, which is what makes that id
trustworthy.

**Delivered in-app only** (T1.15, **D-034**), by polling every 30s as below.
Email is a seam rather than a stub: `channelsFor` returns `['IN_APP']`, and the
`Notification` row — with `channel` and `emailedAt` already in the schema — is
the outbox email will read. SSE/WebSocket push remains P2.

Fan-out is **authorized, not addressed** (**D-035**): a recipient must both hold
the permission that makes the event their business *and* be able to read the
underlying resource. A notification is a disclosure pushed at someone, so
visibility is checked with the same `can()` the API uses.

### 2.12 Client portal (§21)

Deliberately a **separate, narrower surface** — not the agency endpoints with a filter applied.
Different code path, different select set, different tests.

| Method | Path | Status |
|---|---|---|
| `GET` | `/portal/workspaces` — workspaces this client may see | ✅ T1.16 |
| `GET` | `/portal/workspaces/{wsId}/calendar?from&to` | ✅ T1.16 |
| `GET` | `/portal/workspaces/{wsId}/approvals` | ✅ T1.16 |
| `GET` | `/portal/posts/{id}` — client-visible projection only | ✅ T1.16 |
| `GET` `POST` | `/portal/posts/{id}/comments` — forced `visibility: CLIENT_VISIBLE` | ✅ T1.16 |
| `POST` | `/portal/posts/{id}/decide` — `{ decision: APPROVED \| CHANGES_REQUESTED, comment? }` | ✅ T1.16 |
| `GET` | `/portal/workspaces/{wsId}/published` | ✅ T1.16 |
| `GET` | `/portal/workspaces/{wsId}/analytics` · `/assets` | ⬜ Phase 3 / **O2** |

**No organization in a portal URL.** A portal path names a workspace or a post; the tenant is derived
from that row and then cross-checked against membership — the same structure `resolveTenantContext`
uses for an org ref, and the same one decision **D-021** requires of the worker. The agency's slug is
the agency's business, and a client's address bar is not the place for it.

**The two surfaces do not overlap** (**D-038**). `withPortalAuth` refuses every non-`CLIENT`
principal; `withAuth` refuses every `CLIENT` principal. Both answer **404**, so neither surface's
shape is discoverable from the other.

**Reads are portal-owned, writes are delegated** (**D-039**). Every response here is built from an
allowlist select in `features/portal/projection.ts`; a decision goes through `decideApproval` and
therefore through the one state machine (**D-017**), and its result is re-read through the portal
projection before it is returned.

### 2.13 Billing (§38) & platform admin (§28)

| Method | Path | Permission |
|---|---|---|
| `GET` | `/orgs/{orgId}/billing/subscription` | `billing:read` |
| `POST` | `/orgs/{orgId}/billing/checkout-session` | `billing:manage` — P1 |
| `POST` | `/webhooks/stripe` | signature-verified |
| `GET` | `/admin/organizations` · `/admin/users` | `admin:view_system_logs` |
| `GET` | `/admin/jobs` · `/admin/jobs/{id}` | `admin:view_jobs` |
| `POST` | `/admin/jobs/{id}/retry` · `/admin/jobs/{id}/discard` | `admin:retry_job` — body `{ reason }`, mandatory |
| `GET` | `/admin/health` | `admin:view_jobs` |
| `GET` | `/admin/social-accounts?status=NEEDS_RECONNECT` | `admin:view_system_logs` |

Admin responses mask every sensitive value (§28). There is no endpoint, at any privilege level, that
returns a decrypted credential.

**The admin surface has no tenant context** (**D-043**). `withPlatformAdmin` hands a handler a user
and nothing else, so it cannot construct the tenant-scoped client — reading client content is
unreachable rather than merely forbidden. `isPlatformAdmin` is read from the `User` row on every
request, never from a token claim (docs/RBAC.md §1 rule 2), and every non-admin gets **404**.

**Connection status, not connection identity** (**D-044**). `/admin/social-accounts` returns status,
platform, organization and `healthCheckedAt`. Not the account's display name, handle, external id or
`healthError` — which Pages a client manages is the client's information, and docs/RBAC.md §3 note 2
allows the status alone.

**`publish` jobs cannot be re-enqueued from here** (**D-045**). They are browsable and discardable;
retry is refused with a pointer to the organization's own publishing log, so publishing keeps the
single door that **D-028** and **D-029** exist to protect. `GET /admin/jobs/{id}` reports
`retryable: false` for them.

**Both mutating routes require a `reason`** and write it into the **affected organization's own**
audit log with the administrator named as the actor (**D-046**, T1.18 DoD).

### 2.14 Webhooks & health

| Method | Path | Notes |
|---|---|---|
| `GET` `POST` | `/webhooks/meta` | `GET` = subscription verification challenge; `POST` = signature-verified events. Persisted to `WebhookEvent` and processed **asynchronously**; duplicates collapse on `(provider, externalEventId)`. |
| `POST` | `/webhooks/stripe` | Signature-verified, async |
| `GET` | `/api/health` · `/api/health/deep` | Liveness / dependency check |

Webhook handlers **always** verify the signature before parsing, respond `200` fast, and do the work
on the queue. A webhook never trusts a tenant id from its payload — the tenant is resolved through
our own account mapping.

---

## 3. Documentation & contract testing (§34, §31)

- **OpenAPI 3.1 generated from the zod schemas** (`zod-to-openapi`), so the spec cannot drift from
  the implementation; served at `/api/docs` in non-production.
- Every endpoint has a contract test asserting: happy path, validation failure, unauthenticated,
  unauthorised, **and cross-tenant access returning 404**.
- Response shapes are exported as types from `packages/contracts` and consumed by the frontend, so a
  breaking change fails `tsc` rather than production.
