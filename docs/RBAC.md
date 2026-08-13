# AHN Orbit — RBAC & Permission Matrix

> Status: **proposed**. Answers SRS §46.G and §5. Nothing here is assumed silently — every cell is
> an explicit decision, per §5 ("do not assume permissions without documenting them").
> Last updated: 2026-08-11.

---

## 1. Model

Three scopes compose. A permission check passes only if **all applicable scopes** allow it.

```
Platform scope    User.isPlatformAdmin                    → operational access, not tenant data
      ▲
Org scope         OrganizationMembership.role             → OWNER · ADMIN · ACCOUNT_MANAGER
      ▲                                                     CONTENT_CREATOR · APPROVER · CLIENT
Workspace scope   WorkspaceMembership.role                → which clients you can touch at all
      ▲
Brand scope       BrandAssignment (optional narrowing)    → which brands, and may you approve
```

**Rules that hold without exception:**

1. **Deny by default.** No membership row ⇒ no access. There is no implicit inheritance downward
   from an org role into a workspace a user has no membership in — *except* `OWNER` and `ADMIN`,
   which are org-wide by definition and are granted implicit access to every workspace in their org.
2. **Roles come from the database, never from the request.** Not from a header, not from a JWT
   claim, not from a request body (§5). The single exception is `isPlatformAdmin`, mirrored to a
   Firebase custom claim purely as a fast path, and always re-verified against Postgres before any
   privileged action.
3. **`CLIENT` is confined.** A user whose org role is `CLIENT` can only reach the `(portal)` routes,
   only for workspaces where they hold a `WorkspaceMembership`, and only through portal services
   that select a narrowed field set. Internal comments, internal approvals, audit data, cost data,
   and other clients are not merely hidden in the UI — they are not fetched (§21).

   **Enforced in both directions since T1.16** (**D-038**): `withAuth` refuses a `CLIENT` principal
   on every agency route, and `withPortalAuth` refuses every non-`CLIENT` principal on every portal
   route. Both answer `404`. Before T1.16 only the field narrowing existed, so a Client holding
   `post:read` reached the agency post list and received an agency-shaped payload.
4. **Platform admins are not tenant superusers.** `isPlatformAdmin` grants operational visibility
   (organizations, users, jobs, health, subscriptions) and **not** the ability to read client content
   or credentials. Credentials are masked for everyone (§28). Any admin action against tenant data
   is audited with a mandatory reason.

   **Structural since T1.18** (**D-043**): `withPlatformAdmin` produces no `TenantContext`, and the
   tenant-scoped Prisma client is only constructible from one — so an admin handler cannot read
   client content even by mistake. The account board shows connection *status* and never connection
   *identity* (**D-044**), a `publish` job cannot be re-enqueued from the admin panel (**D-045**),
   and both mutating routes write a reasoned audit row into the **affected organization's own** log
   (**D-046**).
5. **Every enforcement point runs the same engine.** Frontend, API routes, server actions, workers,
   webhooks, and media URL issuance all call `rbac.can(ctx, action, resource)` from
   `packages/rbac`. The frontend uses it to *hide* controls; the server uses it to *decide*. Frontend
   checks are never sufficient (§4, §5).

### Permission naming

`resource:action` — e.g. `post:publish`, `social_account:connect`, `analytics:read`.
Resource-level checks additionally verify that the resource's `organizationId` matches the context
and that the actor's workspace/brand scope covers it.

---

## 2. Role definitions

| Role | Scope | Intent |
|---|---|---|
| **Platform Administrator** | Platform | AHN staff operating the SaaS itself. Sees system state, never client content or secrets. |
| **Organization Owner** | Org | The agency's owner. Everything within the org, including billing and deletion. Exactly one required per org. |
| **Organization Admin** | Org | Runs the agency day to day. Everything except billing, org deletion, and ownership transfer. |
| **Account Manager** | Workspace | Owns a set of client workspaces end to end: content, accounts, scheduling, publishing, client relationship. |
| **Content Creator** | Workspace/Brand | Produces content. Drafts and submits, but cannot approve or publish. |
| **Approver** | Workspace/Brand | Internal quality gate. Approves or rejects internally; does not publish. |
| **Client** | Workspace | External. Reviews and approves their own content in the portal. Nothing else. |

---

## 3. Permission matrix (§5, requested table)

**Legend:** ✅ full · 🟡 scoped (own workspaces/brands only, or otherwise limited — see notes) ·
👁 read-only · ❌ none

| Role | Organization | Workspace | Brand | Social Account | Posts | Analytics | Billing |
|---|---|---|---|---|---|---|---|
| **Platform Admin** | 👁 metadata only ¹ | 👁 metadata | ❌ | 👁 status only ² | ❌ | 👁 aggregate ³ | 👁 subscription state |
| **Org Owner** | ✅ incl. delete, transfer | ✅ | ✅ | ✅ | ✅ incl. publish | ✅ | ✅ |
| **Org Admin** | 🟡 manage, no delete/transfer/billing | ✅ | ✅ | ✅ | ✅ incl. publish | ✅ | 👁 |
| **Account Manager** | 👁 | 🟡 own workspaces | 🟡 own workspaces | 🟡 connect/disconnect in own workspaces | 🟡 full incl. approve + publish | 🟡 own workspaces | ❌ |
| **Content Creator** | 👁 name only | 👁 assigned | 👁 assigned | 👁 status only | 🟡 create/edit own drafts, submit for review | 🟡 own posts ⁴ | ❌ |
| **Approver** | 👁 name only | 👁 assigned | 👁 assigned | 👁 status only | 🟡 read all in scope, approve/reject, **no publish** | 🟡 assigned workspaces | ❌ |
| **Client** | ❌ | 👁 assigned only | 👁 assigned only | 👁 name/avatar only | 🟡 read `CLIENT_REVIEW`+ only; approve / request changes / comment | 🟡 own brands, published only | ❌ |

¹ Org name, plan, counts, health — not content.
² Connected / needs-reconnect / revoked. Never tokens, never plaintext, never masked-but-recoverable (§28).
³ Job counts, error rates, API health — not client performance data.
⁴ Analytics for posts they created, so they can learn from results. Confirm — see open question O3.

---

## 4. Detailed permissions

**Legend as above. "own" = within a workspace where the user holds a `WorkspaceMembership`
(and, where `BrandAssignment` rows exist for that brand, where they hold one).**

### 4.1 Organization & members

| Permission | Plat. Admin | Owner | Admin | Acct Mgr | Creator | Approver | Client |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `org:read` | 👁 meta | ✅ | ✅ | ✅ | 👁 | 👁 | ❌ |
| `org:update` | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `org:delete` | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `org:transfer_ownership` | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `org:suspend` (platform action) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `member:invite` | ❌ | ✅ | ✅ | 🟡 client users to own ws | ❌ | ❌ | ❌ |
| `member:list` | 👁 | ✅ | ✅ | 🟡 own ws | 🟡 own ws | 🟡 own ws | ❌ |
| `member:update_role` | ❌ | ✅ | 🟡 not to OWNER | ❌ | ❌ | ❌ | ❌ |
| `member:remove` | ❌ | ✅ | 🟡 not OWNER | ❌ | ❌ | ❌ | ❌ |
| `audit:read` | 👁 platform events | ✅ | ✅ | 🟡 own ws | ❌ | ❌ | ❌ |

### 4.2 Workspace & brand

| Permission | Plat. Admin | Owner | Admin | Acct Mgr | Creator | Approver | Client |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `workspace:create` | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `workspace:read` | 👁 meta | ✅ | ✅ | 🟡 own | 🟡 own | 🟡 own | 🟡 own |
| `workspace:update` (incl. timezone) | ❌ | ✅ | ✅ | 🟡 own | ❌ | ❌ | ❌ |
| `workspace:delete` | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `workspace:manage_members` | ❌ | ✅ | ✅ | 🟡 own, clients only | ❌ | ❌ | ❌ |
| `brand:create` / `brand:update` | ❌ | ✅ | ✅ | 🟡 own | ❌ | ❌ | ❌ |
| `brand:read` | ❌ | ✅ | ✅ | 🟡 own | 🟡 assigned | 🟡 assigned | 🟡 assigned |
| `brand:delete` | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `brand_voice:read` (Brand Brain) | ❌ | ✅ | ✅ | 🟡 own | 🟡 assigned | 🟡 assigned | ❌ |
| `brand_voice:update` | ❌ | ✅ | ✅ | 🟡 own | ❌ | ❌ | ❌ |

### 4.3 Social accounts

| Permission | Plat. Admin | Owner | Admin | Acct Mgr | Creator | Approver | Client |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `social_account:connect` (OAuth) | ❌ | ✅ | ✅ | 🟡 own | ❌ | ❌ | ❌ |
| `social_account:read` | 👁 status | ✅ | ✅ | 🟡 own | 👁 name/status | 👁 name/status | 👁 name only |
| `social_account:reconnect` | ❌ | ✅ | ✅ | 🟡 own | ❌ | ❌ | ❌ |
| `social_account:disconnect` | ❌ | ✅ | ✅ | 🟡 own | ❌ | ❌ | ❌ |
| `social_credential:read_plaintext` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

`social_credential:read_plaintext` has **no holder at all**. Decryption happens only inside the
provider layer, in the worker, in memory. This row exists to make that explicit (§6, §28).

### 4.4 Content & publishing

| Permission | Plat. Admin | Owner | Admin | Acct Mgr | Creator | Approver | Client |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `post:create` | ❌ | ✅ | ✅ | 🟡 own | 🟡 assigned brands | ❌ | ❌ |
| `post:read` | ❌ | ✅ | ✅ | 🟡 own | 🟡 assigned | 🟡 assigned | 🟡 `CLIENT_REVIEW`, `APPROVED`, `SCHEDULED`, `PUBLISHED` only |
| `post:update` | ❌ | ✅ | ✅ | 🟡 own | 🟡 own drafts, pre-approval | ❌ | ❌ |
| `post:delete` | ❌ | ✅ | ✅ | 🟡 own | 🟡 own drafts only | ❌ | ❌ |
| `post:assign` | ❌ | ✅ | ✅ | 🟡 own | ❌ | ❌ | ❌ |
| `post:submit_internal_review` | ❌ | ✅ | ✅ | ✅ | 🟡 own posts | ❌ | ❌ |
| `post:approve_internal` | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ scoped | ❌ |
| `post:submit_client_review` | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ scoped | ❌ |
| `post:approve_client` | ❌ | ✅ ⁵ | ✅ ⁵ | ✅ ⁵ | ❌ | ❌ | ✅ scoped |
| `post:request_changes` | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| `post:schedule` | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `post:reschedule` (calendar drag) | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `post:publish_now` | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `post:cancel_scheduled` | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `post:retry_failed` | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `post:delete_published_remote` | ❌ | ✅ | ✅ | 🟡 own | ❌ | ❌ | ❌ |
| `comment:create` | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 client-visible only |
| `comment:read_internal` | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | **❌** |
| `comment:resolve` | ❌ | ✅ | ✅ | ✅ | 🟡 own threads | ✅ | ❌ |

⁵ Internal roles may record a client approval **on the client's behalf** (a common agency reality:
approval arrives by phone or email). Every such action is audited as `approved_on_behalf_of` with a
mandatory note. Confirm — see open question O1.

**Publishing is deliberately restricted to Owner / Admin / Account Manager.** Approvers approve;
they do not publish. This separation of duties is the point of an approval workflow.

### 4.5 Media

| Permission | Plat. Admin | Owner | Admin | Acct Mgr | Creator | Approver | Client |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `media:upload` | ❌ | ✅ | ✅ | 🟡 own | 🟡 assigned | ❌ | 🟡 if enabled ⁶ |
| `media:read` (signed URL) | ❌ | ✅ | ✅ | 🟡 own | 🟡 assigned | 🟡 assigned | 🟡 own brands |
| `media:update` (tags, folders) | ❌ | ✅ | ✅ | 🟡 own | 🟡 own uploads | ❌ | ❌ |
| `media:delete` | ❌ | ✅ | ✅ | 🟡 own | 🟡 own uploads | ❌ | ❌ |

⁶ Clients supplying their own assets is a common agency workflow, off by default, enabled per
workspace. See open question O2.

Signed URLs are issued **only after** an RBAC check, are short-lived, and encode no more than the
object key — a leaked URL grants a 15-minute window on one object, never a listing (§17).

### 4.6 Analytics, reporting, AI, billing, admin

| Permission | Plat. Admin | Owner | Admin | Acct Mgr | Creator | Approver | Client |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `analytics:read` | 👁 aggregate | ✅ | ✅ | 🟡 own | 🟡 own posts | 🟡 assigned | 🟡 own brands |
| `report:generate` / `report:export` | ❌ | ✅ | ✅ | 🟡 own | ❌ | ❌ | 🟡 own, if enabled |
| `ai:generate` | ❌ | ✅ | ✅ | 🟡 own | 🟡 assigned | ❌ | ❌ |
| `ai:view_usage` | 👁 aggregate | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `billing:read` | 👁 status | ✅ | 👁 | ❌ | ❌ | ❌ | ❌ |
| `billing:manage` | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `admin:view_jobs` / `admin:retry_job` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `admin:view_system_logs` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `admin:impersonate` | 🟡 ⁷ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

⁷ Support impersonation, if built at all, requires org-owner consent, is time-boxed, is audited on
both sides, and is **P2**. Default: not built.

---

## 5. Status transition authority (§10)

The transition table is the server's law; a transition absent from it is rejected regardless of role.

| From → To | Who may |
|---|---|
| `IDEA → DRAFT` | Creator (own), Acct Mgr, Admin, Owner |
| `DRAFT → INTERNAL_REVIEW` | Creator (own), Acct Mgr, Admin, Owner |
| `INTERNAL_REVIEW → CHANGES_REQUESTED` | Approver, Acct Mgr, Admin, Owner |
| `INTERNAL_REVIEW → CLIENT_REVIEW` | Approver, Acct Mgr, Admin, Owner |
| `INTERNAL_REVIEW → APPROVED` | Acct Mgr, Admin, Owner (when client approval not required) |
| `CLIENT_REVIEW → CHANGES_REQUESTED` | **Client**, Acct Mgr, Admin, Owner |
| `CLIENT_REVIEW → APPROVED` | **Client**, Acct Mgr, Admin, Owner (⁵) |
| `CHANGES_REQUESTED → DRAFT` | Creator (own), Acct Mgr, Admin, Owner |
| `APPROVED → SCHEDULED` | Acct Mgr, Admin, Owner |
| `SCHEDULED → PUBLISHING` | **System only** (worker) |
| `PUBLISHING → PUBLISHED / PARTIALLY_PUBLISHED / FAILED` | **System only** (worker) |
| `SCHEDULED → CANCELED` | Acct Mgr, Admin, Owner |
| `FAILED → SCHEDULED` (retry) | Acct Mgr, Admin, Owner |
| any → `CANCELED` | Acct Mgr, Admin, Owner |

Two states — `PUBLISHING` and the terminal publish outcomes — have **no human writer at all**. A
request attempting to set them is rejected with `403`, even from an Owner. This is what §10's
"users must not be able to arbitrarily change status through API requests" means in practice.

Editing content is blocked once status is `APPROVED` or later; editing an approved post silently
would defeat the approval. Editing requires an explicit "reopen", which returns the post to `DRAFT`
and **voids the existing approvals** (a new round is required).

---

## 6. Enforcement points (§5)

| Point | Mechanism |
|---|---|
| Frontend | `useCan()` hides/disables controls. **Never the decision** — cosmetic only. |
| Route handlers | `withAuth({ permission })` wrapper; no handler touches Prisma without it. |
| Server actions | Same wrapper; server actions are public endpoints and are treated as such. |
| Query layer | Tenant-scoped Prisma client refuses un-scoped tenant queries at runtime. |
| Database | Postgres RLS as an independent backstop. |
| Background jobs | Workers construct a `SystemContext` with an explicit, minimal capability set — never "root". A publish worker can transition publish states and nothing else. |
| Webhooks | Signature verification first; tenant resolved from the payload's account mapping, never from a caller-supplied id. |
| Media | Signed URLs issued only after an RBAC check; the bucket blocks all public access. |
| AI | `brandId` authorised before any Brand Brain context is loaded (§24). |

---

## 7. Testing requirements (§32)

Non-negotiable, and treated as product code:

1. **A matrix test that walks this document** — every (role × permission) cell asserted against the
   engine. The table above is the fixture; drift fails CI.
2. **Cross-tenant probes on every endpoint** — an authenticated user from org A requesting every
   resource type in org B must receive `404` (not `403`, which would confirm existence).
3. **Client-portal leakage tests** — internal comments, internal approvals, unapproved posts, other
   brands, cost/audit data must be absent from portal responses at the **payload** level, not just
   invisible in the UI.
4. **Status-transition tests** — every illegal transition rejected; `PUBLISHING` unreachable by any
   human role.
5. **Worker authority tests** — a job payload naming a resource in another org fails closed.

---

## 8. Open questions

- **O1.** May internal roles approve on a client's behalf (⁵)? Common in practice, but it weakens the
  audit story. Default: allowed, audited, with a mandatory note.
- **O2.** May clients upload assets (⁶)? Default: off, enabled per workspace.
- **O3.** Should Content Creators see analytics for their own posts (⁴)? Default: yes — it is how
  creators improve — but some agencies treat performance data as manager-only.
- **O4.** Should `APPROVER` be a role at all, or a *capability* on `BrandAssignment.canApprove`? The
  SRS names it a role (§5), so it is one here, but the capability is also modelled — meaning a
  Content Creator can be granted approval rights on a specific brand. Confirm this is wanted.
- **O5.** Is one `OWNER` per organization enforced, or may there be several? Default: at least one,
  several permitted, and the last one cannot be removed.
