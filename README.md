# AHN Orbit

A multi-tenant agency social media and content operations platform for AHN Group — clients, brands,
social accounts, content workflows, approvals, publishing, analytics, and AI-assisted content
production.

> ## Status: Phase 1 complete (T1.1–T1.19), not yet launched
>
> The product works end to end against a mock provider: an agency can be created, a client
> workspace and brand added, an account connected, a post composed, reviewed internally, approved by
> the client in their own portal, scheduled in the client's timezone, published exactly once, and
> seen live by the client — with the whole journey audited. `pnpm test:e2e` runs that flow.
>
> **No real publish has ever happened.** The Facebook adapter is written and unit-tested but has
> never posted to a real Page, because the permissions it needs (`pages_manage_posts`,
> `pages_read_engagement`, `pages_show_list`) are gated behind **Meta App Review and Business
> Verification — which has not started.** That is the single external blocker to launch, and it is
> 2–4 weeks of wall-clock time including one revision round. See
> [SOCIAL_PROVIDERS.md §2](docs/SOCIAL_PROVIDERS.md) and
> [DEPLOYMENT.md §7](docs/DEPLOYMENT.md).

---

## Getting it running

```bash
pnpm install
pnpm infra:up            # Postgres 17, Redis 7, MinIO
pnpm db:migrate:deploy
pnpm dev                 # web        → http://localhost:3000
pnpm dev:worker          # worker     → http://localhost:3100/health
```

Without `FACEBOOK_APP_ID`/`FACEBOOK_APP_SECRET` the development mock provider stands in, so the
composer, calendar and publishing engine can all be exercised. The registry **refuses the mock in
production**, so the substitution cannot escape.

### Tests

```bash
pnpm test                # unit — no infrastructure
pnpm test:integration    # needs infra up + migrations
pnpm test:e2e            # the §32 flow, end to end
pnpm verify:full         # all three, plus format, lint and typecheck
```

Tests never call a real platform, even when Meta credentials are in your `.env`
([D-047](docs/DECISIONS.md)). The one exception is deliberate and must be asked for by name:
`ORBIT_E2E_REAL_PROVIDER=true pnpm test:e2e`.

---

## What is built

| Area | State |
|---|---|
| Auth, tenancy, RBAC | ✅ Two isolation layers, 58 permissions, composite tenant foreign keys |
| Organizations, workspaces, brands, invitations | ✅ |
| Facebook OAuth, account connection, health & reconnect | ✅ Adapter untested against a real Page |
| Media upload with byte verification | ✅ Bytes decide, not the client |
| Composer, post model, state machine | ✅ |
| Approvals — internal and client gates | ✅ |
| Scheduling and calendar | ✅ DST-correct, no timezone library |
| Publishing engine | ✅ Four idempotency layers; an ambiguous outcome parks rather than retries |
| Publishing logs and failure handling | ✅ |
| Notifications | ✅ In-app; email is a seam, nothing sends |
| Client portal | ✅ Its own surface, its own selects |
| Agency dashboard and alerts | ✅ |
| Platform admin | ✅ No tenant context by construction |
| Observability, docs, E2E | ✅ Sentry is a seam; no SDK installed |
| Analytics, AI, billing | ⬜ Phases 3–4 |

---

## Documents

| Document | Covers |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Topology, request lifecycle, queues, **idempotency strategy (§5.2)**, providers |
| [SECURITY.md](docs/SECURITY.md) | Every load-bearing control, why it exists, and how to verify it |
| [RUNBOOK.md](docs/RUNBOOK.md) | What to do when something is wrong. Start here on call |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Environments, order of operations, scaling, going live |
| [DATABASE.md](docs/DATABASE.md) | Schema rationale, indexes, constraints, tenancy |
| [RBAC.md](docs/RBAC.md) | Roles, permission matrix, transition authority, enforcement points |
| [API.md](docs/API.md) | Endpoint surface, the three audiences, error envelope |
| [SOCIAL_PROVIDERS.md](docs/SOCIAL_PROVIDERS.md) | Capability matrix, Meta specifics, token lifecycle |
| [PROVIDER_GUIDE.md](docs/PROVIDER_GUIDE.md) | How to write a new adapter |
| [DECISIONS.md](docs/DECISIONS.md) | **D-001 … D-048** — decision, reason, alternatives, impact |
| [BUILD-PLAN.md](docs/BUILD-PLAN.md) | Task breakdown with per-task status |
| [00-ANALYSIS.md](docs/00-ANALYSIS.md) | The original SRS analysis, assumptions and open questions |

The API also serves its own description at `GET /api/v1/openapi.json`.

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 15 App Router, React 19, Tailwind + CSS-variable tokens |
| Backend | Route handlers over domain services ([D-011](docs/DECISIONS.md)) |
| Database | PostgreSQL 17 + Prisma 6, UUIDv7, RLS as a backstop |
| Queue | Redis 7 + BullMQ 5, workers on AWS ECS Fargate ([D-002](docs/DECISIONS.md)) |
| Storage | S3 (MinIO locally) |
| Auth | Firebase Auth for identity; **authorization lives in Postgres** ([D-004](docs/DECISIONS.md)) |
| Social | Facebook Pages behind a `SocialProvider` abstraction |

---

## The guarantees that shape everything

1. **Tenant isolation** — two independent layers plus composite foreign keys, provable by test. No
   user reaches another organization's data, even knowing the exact UUID.
   ([D-005](docs/DECISIONS.md), [D-015](docs/DECISIONS.md))
2. **Exactly-once publishing** — idempotent across retries, crashes and ambiguous timeouts, using
   reconciliation rather than blind retry. **When we cannot tell whether a post went out, we stop.**
   ([D-008](docs/DECISIONS.md), [D-027](docs/DECISIONS.md))
3. **A client sees their content and nothing else** — the portal is a separate surface with its own
   queries, not a filtered view of the agency's. ([D-012](docs/DECISIONS.md))
