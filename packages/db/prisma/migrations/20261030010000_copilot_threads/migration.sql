-- ────────────────────────────────────────────────────────────────────────────
-- Copilot conversations (D-109 phase 5).
--
-- One row per thread, private to its person. Kept 90 days after the last
-- message (the worker's retention sweep), and cascaded with the person or
-- the organization.
-- ────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "AgentThread" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "modelHistory" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AgentThread_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentThread_organizationId_userId_updatedAt_idx" ON "AgentThread"("organizationId", "userId", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentThread_updatedAt_idx" ON "AgentThread"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentThread_organizationId_id_key" ON "AgentThread"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "AgentThread" ADD CONSTRAINT "AgentThread_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentThread" ADD CONSTRAINT "AgentThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- Same policy as every other tenant table (see 20260811000200).
ALTER TABLE "AgentThread" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AgentThread"
  USING ("organizationId" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("organizationId" = current_setting('app.current_org_id', true)::uuid);
