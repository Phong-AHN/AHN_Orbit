# AHN Orbit — Security Model

> The controls that are load-bearing, why each exists, and what breaks if it is removed.
> Last updated: 2026-08-12 (T1.19). Answers SRS §4, §5, §6, §17, §21, §28, §33.
>
> Every item here has a test. If one of those tests starts failing, assume a guarantee was broken
> rather than that the test is wrong.

---

## 1. Threat model, briefly

An agency's Orbit account holds the credentials to publish on its clients' behalf. The three things
that would end the product:

1. **One tenant reading another's content or credentials.** Agencies compete with each other.
2. **A post going out twice on a client's Page**, or going out at all when it should not have.
3. **A token leaking** — from a log, a payload, an API response, or a support screen.

Everything below is organised around those three.

---

## 2. Tenant isolation — two independent layers

Neither layer is trusted to be sufficient (**D-005**).

**Layer 1 — the tenant-scoped Prisma client** (`packages/db/src/tenant-scope.ts`). Constructible
**only** from a `TenantContext`. It injects `organizationId` into every query and bans
`findUnique`/`findUniqueOrThrow`/`upsert` on tenant models, because those bypass a `where` filter.
The filter is merged as a **sibling key** rather than an `AND` wrapper, because Prisma needs a
unique field at top level for `update`/`delete`.

**Layer 2 — Postgres RLS** (migrations `…000200`, `…000300`), tested as the non-owner `orbit_app`
role. `…000300` fixed a real bug: `SET LOCAL` reverts to `''`, not `NULL`, on a reused pooled
connection, so the policy uses `NULLIF(current_setting(...), '')::uuid`.

**Layer 3, at the schema** — 34 **composite tenant foreign keys** of the form
`(organizationId, childId) → Parent(organizationId, id)` (**D-015**). A cross-tenant reference is
rejected by the database itself, not by a service remembering to check.

**Residual gap, documented:** `User` references (`createdById`, `assignedToId`, `uploadedById`)
cannot be composite, because a person legitimately belongs to several organizations. Mitigated by
resolving people through `OrganizationMembership` before writing.

**Cross-tenant reads are `404`, never `403`** — everywhere, including when the caller knows the
exact UUID. A 403 would confirm the resource exists.

---

## 3. Three surfaces that do not overlap

| Surface | Wrapper | Who | Everyone else |
|---|---|---|---|
| Agency | `withAuth` | Internal roles | `CLIENT` → **404** (**D-038**) |
| Client portal | `withPortalAuth` | `CLIENT` only | **404** (**D-038**) |
| Platform admin | `withPlatformAdmin` | `isPlatformAdmin` | **404** (**D-043**) |

The portal has **its own services and its own allowlist selects** (**D-012**, **D-039**) — not the
agency endpoints with a filter, because with a shared read path every field added for the agency is
a field somebody has to remember to exclude, and forgetting is silent.

The admin surface produces **no `TenantContext` at all**. Since the scoped client is only
constructible from one, an admin handler *cannot* read client content — it is unreachable rather
than forbidden (**D-043**).

**Portal URLs never name the organization.** The tenant is derived from the workspace or post in the
path and cross-checked against membership.

---

## 4. Authentication and authorization

- **Firebase Auth owns identity; Postgres owns authorization** (**D-004**). Roles are read from the
  database on every request. Only `isPlatformAdmin` is mirrored to a custom claim, and it is
  re-verified against Postgres before any privileged action.
- **`withAuth` enforces a fixed order**: authenticate → resolve user → resolve tenant *from the URL*
  → confine clients → authorize → handler. A handler cannot skip a step because it receives nothing
  usable until every step has run.
- **58 permissions**, a declarative grant matrix (`packages/rbac/src/matrix.ts`), typed denial
  reasons. Anything absent is denied.
- **`social_credential:read_plaintext` has no holder**, at any privilege level, including platform
  admins. The entry exists so that fact is explicit and testable.
- Frontend permission checks only **hide** controls. The server always re-decides.

---

## 5. Protected request fields

`readJsonBody` **refuses** a body carrying a server-derived field and logs a security event, rather
than silently stripping it — a strip makes a probe invisible.

- Global: `organizationId`, `userId`, `actorUserId`, `isPlatformAdmin`, `membershipStatus`.
- Per route: `PROTECTED_POST_FIELDS`, `PROTECTED_APPROVAL_FIELDS`, `PROTECTED_COMMENT_FIELDS`,
  `PROTECTED_PUBLISHING_FIELDS`, `PROTECTED_PORTAL_FIELDS`, `PROTECTED_ADMIN_FIELDS`.

`role` is deliberately **not** on the global list: member management exists to set roles. Escalation
is prevented by the member service, which refuses self-editing, refuses acting on an owner unless
you are one, and refuses granting ownership — guards stronger than a field-name blocklist.

---

## 6. Credentials

- **AES-256-GCM** with **AAD binding** to `{ organizationId, socialAccountId }` and key versioning.
  A credential row moved between tenants **fails to open**.
- Decrypted only in memory, inside the provider layer, in the worker. One decryption path
  (`apps/worker/src/credentials.ts`).
- Never logged, never serialised into a response, never in a queue payload.
- **OAuth `state`** is signed, session-bound, single-use and expiring (`oauth-state.ts`). The threat
  it stops: an attacker completing *their* consent inside *your* session.

---

## 7. Publishing safety

The rule with teeth: **an ambiguous outcome is never retried** (**D-027**).

Four idempotency layers, in the order they engage:

1. **Deterministic job id** — a duplicate add is dropped by BullMQ.
2. **Atomic claim in Postgres** — one conditional `UPDATE … WHERE status='SCHEDULED'`. Exactly one
   concurrent worker wins. **This is the real guarantee**; the rest are optimisation and recovery.
3. **Redis lock per account** — advisory. Losing it cannot cause a duplicate.
4. **Reconciliation before retry** — the attempt row is written `IN_FLIGHT` *before* the provider
   call, which is the whole point: if the worker dies mid-call, that row is the only evidence a call
   may have landed.

`FOUND` → adopt the external id. `NOT_FOUND` → safe to retry. **Anything else parks in
`NEEDS_REVIEW` and nothing automated touches it again** — a human resolves it, on the record, with a
mandatory reason (**D-029**).

There is **one door into publishing**. "Publish now" is scheduling for the present (**D-028**), and
a platform admin cannot re-enqueue a publish job (**D-045**).

---

## 8. Media

**Bytes decide, not the client** (**D-013**). Magic-number sniffing and header parsing (PNG IHDR,
JPEG SOF, GIF LSD, WebP, MP4 box tree) server-side. The declared MIME, the filename and the metadata
are **compared, never trusted**; S3's byte count is authoritative over the declared size. Assets stay
`PENDING` until verification passes and a non-`READY` asset can never be attached to a post.

Storage keys are **derived, never supplied**, and encode the tenant, so `assertKeyBelongsTo` can
refuse to sign a URL for another organization's object. Signed URLs are short-lived (15 min), issued
only after an RBAC check, and grant one object — never a listing.

---

## 9. Background work

- **A job's tenant is derived from its subject row, never its payload** (**D-021**). The payload's
  `organizationId` is a *checked assertion*; a mismatch is a `TenantIsolationError` and a security
  event.
- Payloads carry **identifiers only** — no post bodies (a job queued before an edit must not publish
  the stale copy), no credentials, no signed URLs.
- Payloads are zod-parsed on **both** sides; an unparseable payload is dead-lettered without
  reaching provider code.
- Workers hold an **explicit, minimal capability list** — never "root".
- The web app may only **produce**. Three guards: module split, an ESLint rule, and
  `assertWorkerProcess()` requiring `ORBIT_ROLE=worker` at runtime (**D-022**).
- **One exception to "no identity in payloads"**: `actorUserId` on notification jobs, used *only* to
  suppress self-notification. It can remove a recipient and never add one (**D-037**).

---

## 10. Notifications are a disclosure

Fan-out is **authorized, not addressed** (**D-035**). A recipient must both hold the permission that
makes the event their business *and* pass a `can()` check on the underlying resource — evaluated
with the real policy engine against a principal rebuilt from live memberships. A notification pushed
at someone who could not open the resource is a leak that arrives uninvited.

---

## 11. Audit and security events

- `audit()` writes **inside the same transaction** as the change it records.
- The audit table is **append-only at the grant level** — `orbit_app` holds no UPDATE or DELETE.
- Platform admin actions on tenant data write into the **affected organization's own** audit log,
  with the administrator named and a **mandatory validated reason** (**D-046**). The agency can see
  what we did to them.
- `securityEvent: true` marks: cross-tenant attempts, protected-field probes, job tenant mismatches,
  on-behalf-of approvals, human resolution of a parked publish, a client reaching an agency route, a
  non-admin reaching the admin surface, and every admin action on tenant data.

---

## 12. Logging

**Redaction is code, not discipline.** `packages/observability/src/redact.ts` strips `token`,
`secret`, `password`, `authorization`, `client_secret` and credential fields **by key name**, at any
depth, including inside URLs.

Error responses carry a **safe message and a correlation id** — never a stack trace, a provider
payload or a SQL message. The real detail goes to the log under that id.

**Metrics carry no tenant label** (T1.19): one customer's posting volume must not be readable by
anyone who can reach the metrics port, and per-tenant labels are unbounded cardinality besides.

---

## 13. What is deliberately not built

- **`admin:impersonate`** — P2. If ever built: org-owner consent, time-boxed, audited on both sides.
- **`org:suspend`** — the permission exists, no endpoint uses it. Suspension semantics are product
  behaviour, not plumbing.
- **Agency preview of the client portal** — would mean repeating every leakage test per role
  (**D-038**). If wanted, the honest shape is an explicit, audited "view as client".
- **Email delivery** — the seam exists; nothing sends (**D-034**).

---

## 14. Verifying it

```bash
pnpm test              # unit — policy engine, redaction, state machine, byte sniffing
pnpm test:integration  # RLS as orbit_app, composite FKs, cross-tenant 404s, portal leakage
pnpm test:e2e          # the §32 flow, including that an ambiguous publish never double-posts
```

The tests that matter most for this document:

| Property | Where |
|---|---|
| RLS holds as a non-owner role | `packages/db/src/rls.integration.test.ts` |
| Composite FKs reject cross-tenant refs | `packages/db/src/composite-fk.integration.test.ts` |
| Cross-tenant is 404 with a known UUID | `packages/auth/src/cross-tenant.integration.test.ts`, every feature suite |
| Portal leaks nothing internal | `apps/web/src/features/portal/portal.integration.test.ts` |
| Admin sees no credential material | `apps/web/src/features/admin/admin.integration.test.ts` |
| Notifications respect visibility | `packages/notifications/src/notifications.integration.test.ts` |
| An ambiguous publish never double-posts | `apps/worker/src/publishing/publishing.integration.test.ts`, `apps/web/e2e/` |
