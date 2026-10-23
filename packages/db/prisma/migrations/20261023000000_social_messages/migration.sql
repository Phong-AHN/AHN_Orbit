-- ────────────────────────────────────────────────────────────────────────────
-- Private messages on Facebook Pages and Instagram (D-107).
--
-- ## The identifier this stores, and why comments do not
--
-- SocialComment deliberately has no column for the commenter's id: a reply is
-- addressed to a *comment*, so nobody needs to know who wrote it. A private
-- message cannot work that way. A conversation is with one person, and the
-- platform addresses a reply to that person's id — without it there is nothing
-- to send to.
--
-- So `participantExternalId` exists, and it is the narrowest identifier the
-- platforms offer: Messenger's page-scoped id and Instagram's
-- Instagram-scoped id are both issued *per account*. The same person writing
-- to two clients' Pages has two unrelated ids, so this column cannot be used
-- to follow anyone across brands even by accident.
--
-- ## How long it is kept
--
-- While the account stays connected. Disconnecting deletes the account's
-- conversations and messages outright (not soft-deleted — the reason to keep
-- them is gone with the connection), and retention removes messages older than
-- twelve months and the conversations they leave empty.
--
-- Tenant isolation is the usual two layers: composite foreign keys so a row
-- cannot name another organization's workspace, brand, account or
-- conversation, and RLS so it cannot be read from one.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TYPE "SocialConversationState" AS ENUM ('NEW', 'HANDLED');
CREATE TYPE "SocialMessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

CREATE TABLE "SocialConversation" (
    "id"                    UUID                      NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId"        UUID                      NOT NULL,
    "workspaceId"           UUID                      NOT NULL,
    "brandId"               UUID                      NOT NULL,
    "socialAccountId"       UUID                      NOT NULL,

    "participantExternalId" TEXT                      NOT NULL,
    "participantName"       TEXT,
    "participantUsername"   TEXT,
    "externalThreadId"      TEXT,

    "lastMessageAt"         TIMESTAMPTZ(3)            NOT NULL,
    "lastInboundAt"         TIMESTAMPTZ(3),

    "state"                 "SocialConversationState" NOT NULL DEFAULT 'NEW',
    "assignedToId"          UUID,
    "handledAt"             TIMESTAMPTZ(3),
    "handledById"           UUID,

    "createdAt"             TIMESTAMPTZ(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMPTZ(3)            NOT NULL,

    CONSTRAINT "SocialConversation_pkey" PRIMARY KEY ("id")
);

-- One conversation per person per account. Webhook retries and the backfill
-- both arrive here, and must land on the same row.
-- Named explicitly: the generated name is over Postgres's 63-character limit,
-- and a truncated name would read as drift on every `migrate diff`.
CREATE UNIQUE INDEX "SocialConversation_account_participant_key"
  ON "SocialConversation"("organizationId", "socialAccountId", "participantExternalId");

CREATE UNIQUE INDEX "SocialConversation_organizationId_id_key"
  ON "SocialConversation"("organizationId", "id");

-- The inbox: what needs attention, most recent first.
CREATE INDEX "SocialConversation_organizationId_state_lastMessageAt_idx"
  ON "SocialConversation"("organizationId", "state", "lastMessageAt");

CREATE INDEX "SocialConversation_organizationId_workspaceId_state_idx"
  ON "SocialConversation"("organizationId", "workspaceId", "state");

ALTER TABLE "SocialConversation"
  ADD CONSTRAINT "SocialConversation_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SocialConversation"
  ADD CONSTRAINT "SocialConversation_organizationId_workspaceId_fkey"
  FOREIGN KEY ("organizationId", "workspaceId") REFERENCES "Workspace"("organizationId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SocialConversation"
  ADD CONSTRAINT "SocialConversation_organizationId_brandId_fkey"
  FOREIGN KEY ("organizationId", "brandId") REFERENCES "Brand"("organizationId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SocialConversation"
  ADD CONSTRAINT "SocialConversation_organizationId_socialAccountId_fkey"
  FOREIGN KEY ("organizationId", "socialAccountId") REFERENCES "SocialAccount"("organizationId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A User spans organizations, so these cannot be composite. SET NULL, as on
-- SocialComment: the conversation outlives the colleague who handled it.
ALTER TABLE "SocialConversation"
  ADD CONSTRAINT "SocialConversation_assignedToId_fkey"
  FOREIGN KEY ("assignedToId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SocialConversation"
  ADD CONSTRAINT "SocialConversation_handledById_fkey"
  FOREIGN KEY ("handledById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Same rule as a comment: handled means somebody decided so, and when.
ALTER TABLE "SocialConversation"
  ADD CONSTRAINT "SocialConversation_handled_is_complete"
  CHECK (
    ("state" = 'NEW'     AND "handledAt" IS NULL AND "handledById" IS NULL)
    OR
    ("state" = 'HANDLED' AND "handledAt" IS NOT NULL)
  );

ALTER TABLE "SocialConversation" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SocialConversation"
  USING ("organizationId" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("organizationId" = current_setting('app.current_org_id', true)::uuid);

CREATE TABLE "SocialMessage" (
    "id"              UUID                     NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId"  UUID                     NOT NULL,
    "conversationId"  UUID                     NOT NULL,
    "socialAccountId" UUID                     NOT NULL,

    "externalId"      TEXT                     NOT NULL,
    "direction"       "SocialMessageDirection" NOT NULL,
    "text"            TEXT,
    "attachments"     JSONB                    NOT NULL DEFAULT '[]',
    "sentAt"          TIMESTAMPTZ(3)           NOT NULL,
    "deletedAt"       TIMESTAMPTZ(3),
    "createdById"     UUID,

    "createdAt"       TIMESTAMPTZ(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SocialMessage_organizationId_socialAccountId_externalId_key"
  ON "SocialMessage"("organizationId", "socialAccountId", "externalId");

CREATE UNIQUE INDEX "SocialMessage_organizationId_id_key"
  ON "SocialMessage"("organizationId", "id");

CREATE INDEX "SocialMessage_organizationId_conversationId_sentAt_idx"
  ON "SocialMessage"("organizationId", "conversationId", "sentAt");

CREATE INDEX "SocialMessage_organizationId_sentAt_idx"
  ON "SocialMessage"("organizationId", "sentAt");

ALTER TABLE "SocialMessage"
  ADD CONSTRAINT "SocialMessage_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite, so a message cannot be filed under another tenant's conversation.
ALTER TABLE "SocialMessage"
  ADD CONSTRAINT "SocialMessage_organizationId_conversationId_fkey"
  FOREIGN KEY ("organizationId", "conversationId") REFERENCES "SocialConversation"("organizationId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SocialMessage"
  ADD CONSTRAINT "SocialMessage_organizationId_socialAccountId_fkey"
  FOREIGN KEY ("organizationId", "socialAccountId") REFERENCES "SocialAccount"("organizationId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SocialMessage"
  ADD CONSTRAINT "SocialMessage_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The person's own message never carries one of our users as its author.
ALTER TABLE "SocialMessage"
  ADD CONSTRAINT "SocialMessage_inbound_has_no_author"
  CHECK ("direction" <> 'INBOUND' OR "createdById" IS NULL);

-- An unsent message keeps its place in the conversation and loses its words.
ALTER TABLE "SocialMessage"
  ADD CONSTRAINT "SocialMessage_deleted_has_no_content"
  CHECK ("deletedAt" IS NULL OR ("text" IS NULL AND "attachments" = '[]'::jsonb));

ALTER TABLE "SocialMessage" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SocialMessage"
  USING ("organizationId" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("organizationId" = current_setting('app.current_org_id', true)::uuid);

-- A webhook names an account by the platform's id alone, and the same account
-- may be connected by several organizations, so this lookup is platform-wide.
CREATE INDEX "SocialAccount_platform_externalId_idx"
  ON "SocialAccount"("platform", "externalId");

-- Instagram's username login stores an app-scoped id as `externalId` and
-- delivers webhooks under the professional account id, so the second id is
-- kept beside the first. Filled when the account is subscribed to webhooks.
ALTER TABLE "SocialAccount" ADD COLUMN "webhookExternalId" TEXT;
CREATE INDEX "SocialAccount_platform_webhookExternalId_idx"
  ON "SocialAccount"("platform", "webhookExternalId");
