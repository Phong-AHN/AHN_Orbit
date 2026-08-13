/**
 * What a client is shown (SRS §21, decision D-012).
 *
 * These select sets are the portal's actual security boundary, and they are
 * written as **allowlists** for a reason: a denylist is wrong the moment someone
 * adds a column, and the failure is silent. Adding `Post.internalNote` tomorrow
 * leaks nothing, because nothing here asks for it.
 *
 * Every exclusion below is deliberate and annotated. If you are tempted to add
 * a field, the question to answer first is not "is it useful?" but "would the
 * agency be content for their client to read it in an email?" — because a
 * portal payload is exactly as shareable as one.
 */

/**
 * A post as the client sees it.
 *
 * **Deliberately absent:**
 *  - `createdById` / `assignedToId` — who at the agency wrote and owns it. The
 *    client hired the agency, not a named junior; staffing is not their business
 *    and naming it invites "why is a different person on my account this week?".
 *  - `approvalRequired` — internal workflow configuration (**D-018**). Whether
 *    the agency has switched off the client gate for other posts says something
 *    about how they are treated relative to other clients.
 *  - `contentHash` — a publishing-engine fingerprint (**D-008** layer 4).
 *  - `source` / `sourceIdeaId` — whether a post came from an AI idea is an
 *    agency method, and a client discovering their "bespoke" content was
 *    generated is a commercial problem, not a technical one.
 *  - `deletedAt` — soft-delete bookkeeping.
 */
export const PORTAL_POST_SELECT = {
  id: true,
  title: true,
  body: true,
  status: true,
  scheduledFor: true,
  timezone: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  workspaceId: true,
  brand: { select: { id: true, name: true, logoUrl: true, primaryColor: true } },
} as const;

/**
 * A per-platform variant, for the preview a client approves against.
 *
 * The client is approving *what will actually go out*, which differs per
 * platform, so the copy has to be here. The machinery does not.
 *
 * **Deliberately absent:**
 *  - `socialAccountId` — an internal id. The account's *display name* is
 *    included instead, which is the only thing docs/RBAC.md §4.3 grants a Client
 *    ("name/avatar only").
 *  - `status` — per-account publishing state. `FAILED`, `NEEDS_REVIEW` and
 *    `PUBLISHING` are the agency's problem to solve before the client hears
 *    about it; surfacing them turns every transient hiccup into a client
 *    conversation (**D-027** parks ambiguous publishes precisely so a human can
 *    resolve them quietly).
 *  - `lastError` — provider failure detail.
 *  - `externalPostId`, `claimToken`, `claimedAt`, `contentHash` — publishing
 *    engine internals.
 *  - `platformOptions`, `mentions` — agency-side configuration.
 *
 * `externalPermalink` **is** included: a client seeing their own live post is
 * the point of the published view, and the link is public by definition.
 */
export const PORTAL_VARIANT_SELECT = {
  id: true,
  platform: true,
  body: true,
  linkUrl: true,
  hashtags: true,
  firstComment: true,
  externalPermalink: true,
  publishedAt: true,
  socialAccount: { select: { displayName: true, avatarUrl: true } },
} as const;

/**
 * The client's own approval gate.
 *
 * Queries using this must **also** narrow to `stage: 'CLIENT'`. The select alone
 * is not the control — an internal approval row carries the same columns, and
 * the fact that an internal review happened, was rejected, and went round again
 * is the agency's own process.
 *
 * **Deliberately absent:**
 *  - `requestedById` / `decidedById` — agency staff identity.
 *  - `onBehalfOf` — that an account manager recorded the decision after a phone
 *    call is true and audited (docs/RBAC.md note 5), but it is a record for the
 *    agency's protection, not a portal feature. Surfacing it here without the
 *    reason attached would raise a question the portal cannot answer.
 */
export const PORTAL_APPROVAL_SELECT = {
  id: true,
  state: true,
  round: true,
  requestedAt: true,
  decidedAt: true,
  comment: true,
} as const;

/**
 * A comment the client may read.
 *
 * Queries using this must **also** narrow to `visibility: 'CLIENT_VISIBLE'`.
 * The narrowing belongs in the `where`, never in a filter afterwards — that is
 * the rule T1.10 established and the one this surface exists to honour.
 *
 * **Deliberately absent:**
 *  - `visibility` — a client has no use for a field whose only other value is
 *    one they can never see; including it invites the question.
 *  - `mentionedUserIds` — agency staff ids.
 *  - `resolvedById` — staff identity again.
 *  - the author's `email` **and `id`** — a name and a face are enough to hold a
 *    conversation. The id was in the first version of this select and the
 *    leakage test caught it: a user id is an internal handle, and one belonging
 *    to agency staff is the kind of value that ends up in a support ticket or a
 *    URL somebody tries.
 */
export const PORTAL_COMMENT_SELECT = {
  id: true,
  postId: true,
  parentId: true,
  body: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { name: true, avatarUrl: true } },
} as const;

/**
 * A workspace, as the client's own account rather than the agency's client record.
 *
 * **Deliberately absent:** `clientUploadsEnabled` and every other per-workspace
 * agency setting, `status` (an agency's `ARCHIVED` is not a client's business),
 * and anything that would let one client infer the existence of another.
 */
export const PORTAL_WORKSPACE_SELECT = {
  id: true,
  name: true,
  timezone: true,
} as const;

/**
 * Media metadata.
 *
 * `storageKey` is selected because signing a URL needs it, and is **stripped
 * before the payload leaves the service** — a derived key is still an internal
 * addressing scheme, and a client has the signed URL instead. The portal's
 * leakage test asserts it never appears in a response.
 *
 * **Deliberately absent:** `uploadedById`, `checksum`, `originalFilename`
 * (agency file naming), `rejectionReason`, `tags`, `folderId`.
 */
export const PORTAL_MEDIA_SELECT = {
  id: true,
  kind: true,
  mimeType: true,
  width: true,
  height: true,
  durationMs: true,
  storageKey: true,
} as const;
