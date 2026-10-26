-- ────────────────────────────────────────────────────────────────────────────
-- The AI assistant for private messages (D-108).
--
-- Three tables and a few columns:
--
-- - BrandKnowledgeEntry: what the assistant may answer from, written by the
--   agency for one brand. `usableByAssistant = false` keeps an entry as an
--   internal note that never reaches the model.
-- - BrandAssistant: one row per brand — OFF, SUGGEST or AUTO, staffed hours,
--   grace period, holding message, reply cap, the brand's own escalation terms.
-- - AssistantDecision: every suggestion, automatic reply and hand-over, with
--   the reason and the documents cited, so a colleague can see what was said on
--   the brand's behalf and rate it.
-- - SocialConversation gains the state the assistant reads before answering;
--   SocialMessage records which messages it sent.
--
-- Tenant isolation as everywhere else: composite foreign keys, and RLS.
-- Everything here cascades with its brand or conversation, so disconnecting an
-- account or ageing out a conversation takes its decisions with it.
-- ────────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "AssistantMode" AS ENUM ('OFF', 'SUGGEST', 'AUTO');

-- CreateEnum
CREATE TYPE "KnowledgeEntryKind" AS ENUM ('FAQ', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "AssistantAction" AS ENUM ('SUGGESTED', 'REPLIED', 'ESCALATED');

-- AlterTable
ALTER TABLE "SocialConversation" ADD COLUMN     "assistantPaused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "assistantReplyCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "escalationReason" TEXT,
ADD COLUMN     "lastHumanReplyAt" TIMESTAMPTZ(3),
ADD COLUMN     "needsHuman" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SocialMessage" ADD COLUMN     "sentByAssistant" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "BrandKnowledgeEntry" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "kind" "KnowledgeEntryKind" NOT NULL,
    "title" TEXT NOT NULL,
    "question" TEXT,
    "content" TEXT NOT NULL,
    "usableByAssistant" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BrandKnowledgeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandAssistant" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "mode" "AssistantMode" NOT NULL DEFAULT 'OFF',
    "staffedHours" JSONB NOT NULL DEFAULT '[]',
    "graceMinutes" INTEGER NOT NULL DEFAULT 10,
    "holdingMessage" TEXT,
    "maxRepliesPerConversation" INTEGER NOT NULL DEFAULT 3,
    "escalationTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "suggestSince" TIMESTAMPTZ(3),
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BrandAssistant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantDecision" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "action" "AssistantAction" NOT NULL,
    "category" TEXT,
    "reason" TEXT,
    "text" TEXT,
    "citedEntryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "model" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "rating" BOOLEAN,
    "reviewedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BrandKnowledgeEntry_organizationId_brandId_idx" ON "BrandKnowledgeEntry"("organizationId", "brandId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandKnowledgeEntry_organizationId_id_key" ON "BrandKnowledgeEntry"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BrandAssistant_organizationId_brandId_key" ON "BrandAssistant"("organizationId", "brandId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandAssistant_organizationId_id_key" ON "BrandAssistant"("organizationId", "id");

-- CreateIndex
CREATE INDEX "AssistantDecision_organizationId_conversationId_createdAt_idx" ON "AssistantDecision"("organizationId", "conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "AssistantDecision_organizationId_createdAt_idx" ON "AssistantDecision"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AssistantDecision_organizationId_id_key" ON "AssistantDecision"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "BrandKnowledgeEntry" ADD CONSTRAINT "BrandKnowledgeEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandKnowledgeEntry" ADD CONSTRAINT "BrandKnowledgeEntry_organizationId_workspaceId_fkey" FOREIGN KEY ("organizationId", "workspaceId") REFERENCES "Workspace"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandKnowledgeEntry" ADD CONSTRAINT "BrandKnowledgeEntry_organizationId_brandId_fkey" FOREIGN KEY ("organizationId", "brandId") REFERENCES "Brand"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandKnowledgeEntry" ADD CONSTRAINT "BrandKnowledgeEntry_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandAssistant" ADD CONSTRAINT "BrandAssistant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandAssistant" ADD CONSTRAINT "BrandAssistant_organizationId_workspaceId_fkey" FOREIGN KEY ("organizationId", "workspaceId") REFERENCES "Workspace"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandAssistant" ADD CONSTRAINT "BrandAssistant_organizationId_brandId_fkey" FOREIGN KEY ("organizationId", "brandId") REFERENCES "Brand"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandAssistant" ADD CONSTRAINT "BrandAssistant_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantDecision" ADD CONSTRAINT "AssistantDecision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantDecision" ADD CONSTRAINT "AssistantDecision_organizationId_conversationId_fkey" FOREIGN KEY ("organizationId", "conversationId") REFERENCES "SocialConversation"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantDecision" ADD CONSTRAINT "AssistantDecision_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A reply cap of zero would let AUTO be switched on and never answer; a
-- negative grace would answer before the customer finished typing.
ALTER TABLE "BrandAssistant"
  ADD CONSTRAINT "BrandAssistant_limits_are_sane"
  CHECK ("graceMinutes" BETWEEN 0 AND 240 AND "maxRepliesPerConversation" BETWEEN 1 AND 10);

-- An escalation says which kind; a suggestion or reply says what it was.
ALTER TABLE "AssistantDecision"
  ADD CONSTRAINT "AssistantDecision_escalation_has_category"
  CHECK ("action" <> 'ESCALATED' OR "category" IS NOT NULL);

-- Same policy as every other tenant table (see 20260811000200).
ALTER TABLE "BrandKnowledgeEntry" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "BrandKnowledgeEntry"
  USING ("organizationId" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("organizationId" = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE "BrandAssistant" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "BrandAssistant"
  USING ("organizationId" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("organizationId" = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE "AssistantDecision" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AssistantDecision"
  USING ("organizationId" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("organizationId" = current_setting('app.current_org_id', true)::uuid);
