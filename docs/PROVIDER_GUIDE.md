# Implementing a Social Provider

> How to add a platform to AHN Orbit without touching the core.
> Companion to `SOCIAL_PROVIDERS.md` (what each platform can actually do) and
> `ARCHITECTURE.md` §6 (why the layer is shaped this way).
> Last updated: 2026-08-12.

---

## The one rule

**No platform name may appear outside `packages/providers/{platform}/`.**

There is no `if (platform === 'FACEBOOK')` in the composer, the scheduler, the
publishing worker, or the UI — and there must never be. Anything the core needs
to *decide* is data in `PlatformCapabilities`; anything it needs to *do* is a
method on `SocialProvider`.

If you find yourself wanting to special-case a platform in core code, the
capability descriptor is missing a field. Add the field.

An ESLint boundary rule enforces the import direction. The rule cannot catch a
stray string comparison, so it is also a review checklist item.

---

## What you write

```
packages/providers/src/{platform}/
├── capabilities.ts    the descriptor — write this FIRST
├── client.ts          HTTP calls, auth headers, error mapping
├── oauth.ts           authorization URL, code exchange, refresh
├── publish.ts         publish, reconcile, status, delete
├── analytics.ts       metric fetching with an availability map
├── errors.ts          this platform's code → ProviderErrorKind map
├── index.ts           the SocialProvider implementation
└── {platform}.test.ts calls runProviderContractTests(...)
```

---

## Step 1 — Fill in the capability matrix, before any code

Read the official documentation and complete the platform's column in
`SOCIAL_PROVIDERS.md` §2, **with a source link in §5 for every cell you mark
supported**. A blank cell means "not checked", not "no".

This is not bureaucracy. Every later step reads from the descriptor, and a
guessed limit becomes a production failure the first time a real user hits it.

## Step 2 — Write the descriptor

```ts
import { defineCapabilities } from '@orbit/providers';

export const EXAMPLE_PAGE_CAPABILITIES = defineCapabilities({
  platform: 'EXAMPLE',
  accountType: 'PAGE',
  apiVersion: 'v3.1',
  verifiedOn: '2026-08-12',

  text: { supported: true, maxLength: 5000, allowsEmptyWithMedia: true },
  link: { supported: true, maxCount: 1 },

  media: {
    image: {
      mimeTypes: ['image/jpeg', 'image/png'],
      maxBytes: 8 * 1024 * 1024,
      minWidth: 320,
      minHeight: 320,
      minAspectRatio: 0.8,
      maxAspectRatio: 1.91,
    },
    video: null,          // null means unsupported — never a fake constraint
    gif: null,
    maxAttachments: 10,
    allowsMixedKinds: false,
    carousel: true,
    altText: true,
    required: false,
  },

  hashtags: { supported: true, maxCount: 30 },
  mentions: { supported: false },
  firstComment: { supported: true, maxLength: 2200 },

  scheduling: { providerSide: false },

  lifecycle: { edit: false, delete: true, readStatus: true },

  publishing: {
    idempotencyKey: false,
    reconcilable: true,                 // see step 5 — this is not optional
    rateLimit: { maxPosts: 25, windowMs: 86_400_000 },
  },

  analytics: {
    post: true,
    account: true,
    metrics: ['views', 'likes', 'comments'],
    deprecatedMetrics: ['impressions'], // withdrawn: report, never chart as 0
  },

  webhooks: { supported: true },
});
```

`defineCapabilities` validates on the way in and rejects incoherent
descriptors — attachments with no described media kind, a metric listed as both
available and deprecated, `editOwnPostsOnly` without `edit`. A malformed
descriptor fails at boot, not at the first publish.

**Different account types get different descriptors.** A Page and a Creator
account are not the same platform as far as validation is concerned; branch
inside `capabilities(accountType)`.

## Step 3 — Map the platform's errors

```ts
import { ProviderErrorMap } from '@orbit/providers';

export const exampleErrors = new ProviderErrorMap({
  '190': 'AUTHENTICATION',   // subcodes like 190.463 match by prefix
  '10':  'PERMISSION',
  '4':   'RATE_LIMIT',
  '100': 'VALIDATION',
  '324': 'MEDIA',
});
```

Then in the client, funnel *everything* through normalization:

```ts
if (!response.ok) {
  const body = await response.json().catch(() => ({}));
  throw toAppError('EXAMPLE', {
    kind: exampleErrors.classify(body?.error?.code, response.status),
    message: body?.error?.message ?? `HTTP ${response.status}`,
    providerCode: body?.error?.code,
    httpStatus: response.status,
    retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after') ?? undefined),
  });
}
```

and wrap transport failures with `normalizeUnknownError`, which classifies an
abort or reset as `TIMEOUT` rather than a plain failure. That distinction is
load-bearing: a timeout means *the outcome is unknown*, and the engine must
reconcile rather than retry.

**Retry behaviour follows from the kind, so classify carefully:**

| Kind | Engine behaviour |
|---|---|
| `AUTHENTICATION` | Never retried. Account → `NEEDS_RECONNECT`, queue paused, user notified |
| `RATE_LIMIT` | Rescheduled at `retryAfter`; does not consume an attempt |
| `VALIDATION` / `MEDIA` / `PERMISSION` | Never retried — the content or grant is wrong, not the moment |
| `UNAVAILABLE` | Retried with exponential backoff |
| `TIMEOUT` | **Reconciled before any retry** |

Never let a raw platform message become a `userMessage`. Pass an explicit safe
one, or rely on the taxonomy's default.

## Step 4 — OAuth and the credential lifecycle

- `getAuthorizationUrl` must embed the caller's `state` verbatim and must never
  contain the client secret. The state is signed, single-use and session-bound
  by the caller — do not invent your own.
- `exchangeCode` runs **server-side only** and returns *every* connectable
  account. One authorization commonly yields many (a user administering several
  Pages), so the connect flow is always "exchange, then choose".
- `refreshCredential` returns one of three outcomes, and the distinction matters:
  `STILL_VALID` (do nothing), `REFRESHED` (persist the new credential), or
  `REQUIRES_RECONNECT` (a human must reauthorize — never loop).
- `probeHealth` reports granted and **missing** scopes. Health is probe-driven,
  not expiry-driven: platform tokens frequently die without expiring.

## Step 5 — Publish and reconcile

`publish` is the easy half. `reconcile` is the half that makes exactly-once
publishing possible.

When a publish call times out, the outcome is genuinely unknown — the post may
or may not exist. If the platform accepts no client idempotency key, the *only*
safe way to retry is to look first:

```ts
async reconcile(ctx: ReconcileContext): Promise<ReconcileResult> {
  const recent = await this.client.listRecentPosts(ctx.account.externalId, {
    since: new Date(ctx.attemptedAt.getTime() - ctx.windowMs),
  });

  const match = recent.find((p) => matchesPublishedText(p.message, ctx.body));
  if (match) {
    return { outcome: 'FOUND', externalPostId: match.id, publishedAt: new Date(match.created_time) };
  }
  return { outcome: 'NOT_FOUND' };
}
```

Three outcomes, and **`INCONCLUSIVE` is a real answer**. If the listing call
itself fails, or the platform's response is ambiguous, return `INCONCLUSIVE` —
the engine parks the post for a human rather than guessing. Returning
`NOT_FOUND` when you are unsure is how a duplicate post reaches a client's
audience.

Declaring `reconcilable: false` alongside `idempotencyKey: false` is rejected by
the contract suite, because that combination makes exactly-once publishing
impossible.

## Step 6 — Analytics with an availability map

Return an availability entry for **every** metric, and never invent a number:

```ts
return {
  metrics: { views: 1234, likes: 56 },
  availability: {
    views: 'AVAILABLE',
    likes: 'AVAILABLE',
    impressions: 'DEPRECATED',   // withdrawn by the platform
    saves: 'UNSUPPORTED',        // never offered here
  },
  capturedAt: clock.now(),
  apiVersion: 'v3.1',
};
```

A withdrawn metric must be absent from `metrics` and marked `DEPRECATED` in
`availability`. Storing it as `0` produces a chart that quietly lies — SRS §18
requires unavailable metrics be clearly indicated.

## Step 7 — Run the contract suite

```ts
import { runProviderContractTests } from '@orbit/providers/contract';

runProviderContractTests({
  name: 'Example',
  createProvider: () => new ExampleProvider(fakeHttpClient),
  validCredential: () => ({ accessToken: 'test', scopes: ['publish'], keyVersion: 1 }),
  sampleAccount: { externalId: '123', accountType: 'PAGE' },
  validDraft: () => ({ body: 'Hello' }),
});
```

The suite is not a formality — it encodes the promises the publishing engine
relies on. It checks that the descriptor parses and is cheap to build, that
validation is pure and agrees with the shared engine, that the authorization URL
carries the state and no secret, that publish returns an id without leaking
credentials, that reconciliation distinguishes `FOUND` from `NOT_FOUND`, that
errors are taxonomy instances, and that analytics carry availability.

Add platform-specific tests alongside it. The suite is a floor, not a ceiling.

## Step 8 — Register

```ts
registerProvider(new ExampleProvider(deps));
```

Development-only adapters pass `{ developmentOnly: true }`, and the registry
**throws if that happens in production** — a mock cannot reach real traffic by
misconfiguration.

---

## Checklist

- [ ] `SOCIAL_PROVIDERS.md` column filled in, with source links in §5
- [ ] Descriptor written and passing `defineCapabilities`
- [ ] Error code map, with transport failures classified as `TIMEOUT`
- [ ] OAuth: state passed through, secret server-side only, all accounts returned
- [ ] `refreshCredential` distinguishes all three outcomes
- [ ] `probeHealth` reports missing scopes
- [ ] `reconcile` implemented, `INCONCLUSIVE` used honestly
- [ ] Analytics carry an availability entry per metric
- [ ] `runProviderContractTests` green
- [ ] Registered, and limitations documented in `SOCIAL_PROVIDERS.md`
- [ ] No platform name anywhere outside the adapter directory

---

## Reference implementation

`packages/providers/src/mock/mock-provider.ts` is the shortest complete
adapter. It implements every method, injects the faults the publishing engine
must survive (rate limit, expired auth, and both timeout cases — published and
not published), and passes the contract suite. Read it before writing a new one.
