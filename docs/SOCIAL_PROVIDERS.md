# AHN Orbit — Social Provider Capability Matrix

> Status: **Facebook verified against official Meta documentation on 2026-08-11. All other providers
> are UNVERIFIED and deliberately left blank.**
>
> SRS §46.I: *"Only mark capabilities as supported when verified against the official provider API."*
> SRS §7: *"Do not pretend unsupported API functionality exists."*
> This document honours both literally. A blank cell means **we have not checked**, not "no".

---

## 1. Verification legend

| Mark | Meaning |
|---|---|
| **✅ V** | Verified against official provider documentation, with the source linked in §5 |
| **⚠️ V-L** | Verified as supported, **with limits or caveats** — see notes |
| **❌ V** | Verified as **not** available via the official API |
| **— (blank)** | **Not yet verified.** Do not build against this cell. |

---

## 2. Capability matrix (SRS §46.I)

Only Facebook is in MVP scope (§51). The remaining columns exist to show the matrix's shape and are
intentionally empty until each provider's documentation is read and cited.

| Capability | **Facebook Pages** | Instagram | LinkedIn | X | TikTok | YouTube | Threads | Pinterest |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| OAuth | ✅ V | — | — | — | — | — | — | — |
| App Review required | ⚠️ V-L ¹ | — | — | — | — | — | — | — |
| Publish text/link | ✅ V | — | — | — | — | — | — | — |
| Publish single image | ✅ V | — | — | — | — | — | — | — |
| Publish multi-image | ⚠️ V-L ² | — | — | — | — | — | — | — |
| Publish video | ⚠️ V-L ³ | — | — | — | — | — | — | — |
| Publish Reels / short video | ⚠️ V-L ⁴ | — | — | — | — | — | — | — |
| Carousel (native) | — ⁵ | — | — | — | — | — | — | — |
| Provider-side scheduling | ⚠️ V-L ⁶ | — | — | — | — | — | — | — |
| Edit published post | ⚠️ V-L ⁷ | — | — | — | — | — | — | — |
| Delete published post | ✅ V | — | — | — | — | — | — | — |
| Read post status | ✅ V | — | — | — | — | — | — | — |
| Post analytics | ⚠️ V-L ⁸ | — | — | — | — | — | — | — |
| Account analytics | ⚠️ V-L ⁸ | — | — | — | — | — | — | — |
| Webhooks | — | — | — | — | — | — | — | — |
| Idempotency key on publish | ❌ V ⁹ | — | — | — | — | — | — | — |

**Notes**

1. `pages_manage_posts`, `pages_read_engagement`, and `pages_show_list` all require **full App Review
   plus Business Verification** before they work on Pages the app does not own. Budget 5–10 business
   days for a first review and 2–4 weeks including one revision round. This is the Phase 1 critical
   path (`00-ANALYSIS.md` R1).
2. No single "multi-photo" endpoint. Upload each photo to `/{page-id}/photos` with
   `published=false`, collect the returned ids, then `POST /{page-id}/feed` with
   `attached_media[n]={"media_fbid":"<id>"}`. Multi-step, and partial failure must be handled.
3. Video publishing goes through the **Video API** and the **Resumable Upload API**
   (`POST /{page-id}/videos` with a file handle). Requires chunked upload with offset tracking —
   a materially larger piece of work than photos.
4. Reels use a distinct three-phase flow: `POST /{page-id}/video_reels` (`upload_phase=start`) →
   upload to **`rupload.facebook.com`** → `POST /{page-id}/video_reels`
   (`upload_phase=finish`, `video_state=PUBLISHED`). Verified constraints: **.mp4, 9:16, ≥540×960
   (1080×1920 recommended), 24–60 fps, 3–90 seconds, H.264/H.265/VP9/AV1, AAC stereo 48kHz.**
   **Rate limit: 30 API-published Reels per rolling 24 hours per Page.**
5. Facebook has no "carousel" post type equivalent to Instagram's. A multi-photo post (note 2) is the
   closest analogue. The capability descriptor must report `carousel: false` for Facebook so the
   composer does not offer it (§7 graceful degradation).
6. Native scheduling exists: `published=false` + `scheduled_publish_time`, **but the official Pages
   API doc states the window is 10 minutes to 30 days from the request.** AHN Orbit schedules through
   its own queue regardless (§13) — provider-side scheduling is a possible fallback only, and its
   30-day ceiling means it cannot be the primary mechanism.
7. **"An app can only update a Page post if the post was made using that app."** Posts created
   elsewhere (Business Suite, the Facebook app, a previous tool) are read-only to us. The capability
   must be evaluated per post, not per platform, and the UI must explain why editing is unavailable.
8. Metrics are available but the metric *names* have changed — see §3. Deprecated metrics return an
   **invalid metric error**, not an empty result.
9. `/{page-id}/feed` accepts **no client-supplied idempotency key**. This is the sole reason
   `reconcile()` exists in the provider interface (`ARCHITECTURE.md` §5.2, §6).

---

## 3. Facebook Page Insights — deprecations (verified, and already in effect)

This is the single most damaging thing to get wrong: any implementation written against
pre-2025 tutorials **will fail at runtime**, because deprecated metrics now return an invalid-metric
error rather than degrading quietly.

| Deprecated metric | Deprecated on | Replacement |
|---|---|---|
| `page_impressions` | 2025-11-15 | `page_media_view` |
| `page_impressions_paid` | 2025-11-15 | `page_media_view` with `is_from_ads` breakdown |
| `page_fans` | 2025-11-15 | **`page_follows`** |
| `page_fans_city` / `page_fans_country` | 2025-11-15 | `page_follows_city` / `page_follows_country` |
| `post_impressions` | 2025-11-15 | `post_media_view` |
| `post_impressions_paid` | 2025-11-15 | `post_media_view` with `is_from_ads` breakdown |
| `post_impressions_fan` | 2025-11-15 | `post_media_view` with `is_from_followers` breakdown |
| `page_impressions_unique` | 2025-06-15 | `page_total_media_view_unique` |
| `post_impressions_unique` | 2025-06-15 | `post_total_media_view_unique` |
| `page_engaged_users` | 2024-03-14 | no direct replacement |
| `page_positive_feedback_by_type` (+ variants) | 2024-03-14 | no direct replacement |
| Reels unique impressions | **2026-06-15** | Reels **play count** only |
| Various unique-impression and 3-second-video-view metrics | **2026-06-15** | no direct replacement |

### Announced for v26.0 (from the v25.0 changelog, verified 2026-08-14)

Not broken yet. Listed here — and marked deprecated in the capability descriptor
— *before* they break, so the Phase 3 rollup is never built on one.

| Metric | Replacement |
|---|---|
| `page_posts_impressions` | `page_total_media_view_unique` |
| `post_video_views_unique` | no direct replacement |
| `total_video_impressions` / `total_video_impressions_unique` | no direct replacement |
| `PAGE_STORY_IMPRESSIONS_BY_STORY_ID` (+ `_UNIQUE`) | no direct replacement |

### Instagram media metrics (verified 2026-08-14)

Instagram's deprecation is a different shape and easy to miss: the whole
play-and-impression family went on **2025-04-21** with v22.0, replaced by a
single `views`.

| Deprecated metric | Replacement |
|---|---|
| `impressions` | **`views`** |
| `plays` | **`views`** |
| `clips_replays_count` | **`views`** |
| `ig_reels_aggregated_all_plays_count` | **`views`** |

> `impressions` continues to return data for media created **on or before
> 2024-07-01**. It looks alive in a spot check and is dead for anything
> published since — which is worse than a clean failure, because it produces a
> number rather than an error.

### Instagram **account** insights are not Instagram **media** insights (verified 2026-08-14)

A separate endpoint with separate rules. Assuming parity — with Facebook, or
even with Instagram's own media metrics — produces a call that errors rather
than one that degrades.

| Difference | Media (`/{ig-media-id}/insights`) | Account (`/{ig-user-id}/insights`) |
|---|---|---|
| The save metric | `saved` | **`saves`** |
| Shape | `values` series | `total_value` object, with `metric_type=total_value` |
| Period | lifetime totals | `day` |

**Requested:** `reach`, `views`, `likes`, `saves`, `shares`, `comments`,
`total_interactions`, `profile_links_taps`, `accounts_engaged`.

**Deliberately not requested, and this is a real limitation rather than an
oversight** (**D-059**):

| Excluded | Why |
|---|---|
| `follows_and_unfollows` | 100-follower minimum |
| `follower_demographics`, `engaged_audience_demographics` | 100-follower minimum, `lifetime` period, and a `timeframe` parameter — a different call shape |
| `replies`, `reposts` | Story/DM oriented; nothing reads them, and an unread metric is still quota on every poll |

> One invalid metric fails the **whole batch**. Including a follower-gated
> metric would leave a new client account with forty followers holding *no*
> analytics at all, rather than one missing number. That is why the gated ones
> are out rather than merely marked unavailable.

**Consequences for the design:**

- The metric list is **provider-versioned configuration**, never string literals scattered through
  services. When Meta deprecates again — and it will — the change is one config edit plus a
  migration note.
- `PostAnalytics.availability` / `AnalyticsSnapshot.availability` record per-metric status
  (`AVAILABLE | UNSUPPORTED | DEPRECATED | ERROR`). §18 demands unavailable metrics be *clearly
  indicated*; a deprecated metric must never be stored or charted as `0`.
- **Set expectations with the agency:** AHN Orbit's Facebook numbers will not match historical Meta
  Business Suite reports, because the underlying metrics changed. That is Meta's doing, not a bug,
  and it needs to be said before the first client report goes out.
- Every metric name in the adapter carries the Graph API version it was verified against, and the
  version is stored on each snapshot row.

---

## 4. Facebook token lifecycle (verified)

```
Short-lived user token (~1–2h)
      ↓ server-side exchange (app secret — never client-side)
Long-lived user token (~60 days)
      ↓ GET /me/accounts
Page access token(s) — generally do not expire, but ARE invalidated by:
      • user password change        • permission revocation
      • app permission review       • user losing Page access
```

Design consequences:

- **Do not assume a Page token is permanent.** `SocialAccount.status` is driven by an hourly
  `account-health` probe, not by an expiry timestamp (`ARCHITECTURE.md` §5.1).
- A `ProviderAuthenticationError` immediately marks the account `NEEDS_RECONNECT`, pauses its
  publish queue, and notifies (§14, §20, §22). It never triggers a retry — retrying a dead token
  just burns quota.
- **Implemented in T1.7.** `accountStatusForErrorCode` decides what a failure implies about the
  *account* as opposed to the post in flight — only `PROVIDER_AUTHENTICATION_ERROR` and
  `PROVIDER_PERMISSION_ERROR` demote it, because a rejected caption says nothing about the
  credential. "Pausing the queue" is two independent things: the publish engine refuses a
  non-`ACTIVE` account before the call, and the scheduler sweep stops enqueueing its variants
  without cancelling them (**D-032**).
- **A transient outage is not a verdict.** A timeout or a 500 from a probe propagates as the error
  it is and leaves the account alone; marking every account `NEEDS_RECONNECT` during a five-minute
  Meta outage would send a reconnect prompt to every client for no reason.
- The token exchange happens **server-side only**; the app secret never leaves the server (§6).
- Meta's own documentation warns that token lifetimes may change without notice — so lifetime is
  never hardcoded as a business rule.

---

## 5. Sources (verified 2026-08-11)

- [Facebook Pages API — Documentation](https://developers.facebook.com/docs/pages-api/) — permissions, App Review
- [Facebook Pages API — Posts](https://developers.facebook.com/docs/pages-api/posts) — `/feed`, `/photos`, scheduling window, edit/delete constraints
- [Video API — Publish a Reel](https://developers.facebook.com/docs/video-api/guides/reels-publishing/) — three-phase flow, `rupload.facebook.com`, format/duration limits, 30/24h rate limit
- [Video API](https://developers.facebook.com/docs/video-api/) — Resumable Upload API
- [Deprecated Facebook Page Insights Metrics](https://developers.facebook.com/documentation/pages-api/platforminsights/page/deprecated-metrics) — the deprecation table in §3
- [Page Insights API Updates (Meta blog, 2025-08-15)](https://developers.facebook.com/blog/post/2025/08/15/page-insights-api-updates/) — `impressions` → `views`
- [Generate Long-Lived User and Page Access Tokens](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/) — token lifecycle
- [Page/insights — Graph API Reference](https://developers.facebook.com/docs/graph-api/reference/insights/) — metric reference

---

## 6. Still to verify before Facebook implementation begins

Deliberately listed rather than guessed. Each is a task in `BUILD-PLAN.md`.

- [ ] Exact character limit for a Page feed post (commonly cited as 63,206 — **not** verified here)
- [ ] Photo endpoint constraints: accepted MIME types, max file size, min/max dimensions, aspect-ratio bounds
- [ ] Video endpoint constraints for **non-Reels** video (Reels are verified in §2 note 4)
- [ ] Maximum number of photos in one `attached_media` post
- [ ] Graph API version to pin, and its published deprecation date
- [ ] Standard feed-publishing rate limits (the 30/24h figure is verified for **Reels only**)
- [ ] Whether Page-level webhooks give us anything useful for publish confirmation
- [ ] Exact permission set needed for reading Page Insights (`read_insights`) alongside publishing
- [ ] Business Verification requirements and current processing time for the AHN Group Meta app

**No cell in §2 moves from blank to ✅ without a documentation link added to §5.** That rule is the
whole point of this file.

---

## 7. Adding the next provider

The adapter contract (`ARCHITECTURE.md` §6) makes a new provider a self-contained package. The
checklist, in order:

1. Read the official docs; fill this matrix **first**, with links. No code before the matrix.
2. Write the `PlatformCapabilities` descriptor — this alone drives composer validation.
3. Implement OAuth + credential storage + health probe.
4. Implement `validate()` (pure) and `publish()`.
5. Implement `reconcile()` — or document why the provider's idempotency key makes it unnecessary.
6. Implement analytics with an explicit availability map.
7. Contract tests against the provider's sandbox where one exists; recorded fixtures otherwise.
8. Document limitations in this file (§7 requires provider-specific limitations be documented).

**Instagram is the cheapest second provider** — same Meta app, same Graph API, same App Review
submission, and it can be added to the existing review rather than a new one. It is the P1 default
(`00-ANALYSIS.md` C13).
