-- ────────────────────────────────────────────────────────────────────────────
-- Audience comments and the replies sent back (SRS §22 — community management).
--
-- The first table in Orbit that holds anything about the *audience* rather than
-- about the agency or its clients, which is why the privacy policy changed in
-- the same commit. It said Orbit collects no data about the people who see a
-- published post, and that was true until this existed.
--
-- ## What this table deliberately does not have
--
-- **A commenter identifier.** The platform serves one with every comment and
-- the obvious design keeps it: it would let us group a person's comments,
-- recognise a repeat commenter, or follow them across posts. Nothing in the
-- product needs any of that — a reply is addressed to a *comment*, and
-- threading uses the platform's own parent id — so the adapter reads the
-- identifier only to decide whether a comment is the brand's own reply, and
-- then drops it. What is stored is the public display name shown beside the
-- comment, and the comment itself.
--
-- The cheapest way to keep audience data out of a database is to have nowhere
-- to put it.
--
-- ## Scoped to posts Orbit published
--
-- `postVariantId` is NOT NULL on purpose. A Page's older posts — made before
-- Orbit, or by hand — have no workspace or brand to attribute them to, and
-- guessing would file one client's comments in another client's queue. So
-- ingestion covers what Orbit put out, and the boundary is a column rather
-- than a convention.
--
-- Tenant isolation follows the same two layers as every other table here: the
-- composite foreign keys mean a comment cannot name a workspace, brand,
-- account or variant in another organization, and RLS means it cannot be read
-- from one.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TYPE "SocialCommentOrigin" AS ENUM ('AUDIENCE', 'ORBIT');
CREATE TYPE "SocialCommentState" AS ENUM ('NEW', 'HANDLED');

CREATE TABLE "SocialComment" (
    "id"               UUID                  NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId"   UUID                  NOT NULL,
    "workspaceId"      UUID                  NOT NULL,
    "brandId"          UUID                  NOT NULL,
    "socialAccountId"  UUID                  NOT NULL,
    "postVariantId"    UUID                  NOT NULL,

    "externalId"       TEXT                  NOT NULL,
    "parentExternalId" TEXT,
    "origin"           "SocialCommentOrigin" NOT NULL,
    "authorName"       TEXT,
    "message"          TEXT                  NOT NULL,
    "permalink"        TEXT,
    "postedAt"         TIMESTAMPTZ(3)        NOT NULL,

    "state"            "SocialCommentState"  NOT NULL DEFAULT 'NEW',
    "assignedToId"     UUID,
    "handledAt"        TIMESTAMPTZ(3),
    "handledById"      UUID,
    "createdById"      UUID,

    "createdAt"        TIMESTAMPTZ(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMPTZ(3)        NOT NULL,

    CONSTRAINT "SocialComment_pkey" PRIMARY KEY ("id")
);

-- Ingestion runs repeatedly over the same post and must be idempotent. Scoped
-- by account as well as organization because a platform's comment ids are only
-- unique within that platform.
CREATE UNIQUE INDEX "SocialComment_organizationId_socialAccountId_externalId_key"
  ON "SocialComment"("organizationId", "socialAccountId", "externalId");

-- The composite key every tenant-scoped table exposes, so the next table that
-- references this one finds it already there.
CREATE UNIQUE INDEX "SocialComment_organizationId_id_key"
  ON "SocialComment"("organizationId", "id");

-- The queue, which is the screen this table exists for: what still needs
-- attention, newest first.
CREATE INDEX "SocialComment_organizationId_state_postedAt_idx"
  ON "SocialComment"("organizationId", "state", "postedAt");

-- One client's queue. An agency with thirty clients opens this filtered far
-- more often than it opens the whole thing.
CREATE INDEX "SocialComment_organizationId_workspaceId_state_idx"
  ON "SocialComment"("organizationId", "workspaceId", "state");

-- The thread under one published post, including our own replies.
CREATE INDEX "SocialComment_organizationId_postVariantId_idx"
  ON "SocialComment"("organizationId", "postVariantId");

ALTER TABLE "SocialComment"
  ADD CONSTRAINT "SocialComment_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite, so a comment cannot be filed against another tenant's workspace,
-- brand, account or variant even if an id were known exactly.
ALTER TABLE "SocialComment"
  ADD CONSTRAINT "SocialComment_organizationId_workspaceId_fkey"
  FOREIGN KEY ("organizationId", "workspaceId") REFERENCES "Workspace"("organizationId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SocialComment"
  ADD CONSTRAINT "SocialComment_organizationId_brandId_fkey"
  FOREIGN KEY ("organizationId", "brandId") REFERENCES "Brand"("organizationId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SocialComment"
  ADD CONSTRAINT "SocialComment_organizationId_socialAccountId_fkey"
  FOREIGN KEY ("organizationId", "socialAccountId") REFERENCES "SocialAccount"("organizationId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Cascade: a deleted variant takes its comment thread with it. The thread is
-- about that post and means nothing without it.
ALTER TABLE "SocialComment"
  ADD CONSTRAINT "SocialComment_organizationId_postVariantId_fkey"
  FOREIGN KEY ("organizationId", "postVariantId") REFERENCES "PostVariant"("organizationId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A User spans organizations, so these three cannot be composite. SET NULL:
-- the record of what the audience said, and that somebody dealt with it,
-- outlives the person who did — losing the name is better than losing the row.
ALTER TABLE "SocialComment"
  ADD CONSTRAINT "SocialComment_assignedToId_fkey"
  FOREIGN KEY ("assignedToId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SocialComment"
  ADD CONSTRAINT "SocialComment_handledById_fkey"
  FOREIGN KEY ("handledById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SocialComment"
  ADD CONSTRAINT "SocialComment_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- A reply is ours and carries an author; an audience comment is not ours and
-- carries none. Stated as a constraint rather than trusted to the ingestion
-- path, which is the only thing that writes AUDIENCE rows today and will not
-- be the only thing forever.
ALTER TABLE "SocialComment"
  ADD CONSTRAINT "SocialComment_audience_has_no_author"
  CHECK ("origin" <> 'AUDIENCE' OR "createdById" IS NULL);

-- Handled means somebody decided it was handled, and when. Half a record of
-- that is worse than none, because the queue would show it as dealt with while
-- nothing says by whom.
ALTER TABLE "SocialComment"
  ADD CONSTRAINT "SocialComment_handled_is_complete"
  CHECK (
    ("state" = 'NEW'     AND "handledAt" IS NULL AND "handledById" IS NULL)
    OR
    ("state" = 'HANDLED' AND "handledAt" IS NOT NULL)
  );

-- Same policy as every other tenant table (see 20260811000200).
ALTER TABLE "SocialComment" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SocialComment"
  USING ("organizationId" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("organizationId" = current_setting('app.current_org_id', true)::uuid);
