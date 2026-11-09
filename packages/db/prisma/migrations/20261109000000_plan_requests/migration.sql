-- ────────────────────────────────────────────────────────────────────────────
-- Plan change requests (D-116).
--
-- Plans change by hand for now: an organization's owner asks for a plan, AHN
-- arranges payment, and a platform administrator approves or declines. One row
-- per request, kept after it is decided so the history stays readable. The
-- plan's limits are written to "Subscription" when a request is approved; this
-- table only records the asking and the answer.
--
-- Additive only: a new enum and a new table. Nothing existing is altered, so
-- the code that is live before this deploy is unaffected by it.
-- ────────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "PlanRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "PlanRequest" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "fromPlan" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "note" TEXT,
    "status" "PlanRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" UUID,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PlanRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlanRequest_organizationId_createdAt_idx" ON "PlanRequest"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "PlanRequest_status_createdAt_idx" ON "PlanRequest"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlanRequest_organizationId_id_key" ON "PlanRequest"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "PlanRequest" ADD CONSTRAINT "PlanRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanRequest" ADD CONSTRAINT "PlanRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanRequest" ADD CONSTRAINT "PlanRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- At most one request waiting per organization. Two people pressing the button
-- at once get one request and one conflict, not two requests an administrator
-- has to reconcile.
CREATE UNIQUE INDEX "PlanRequest_one_pending_per_organization"
  ON "PlanRequest"("organizationId")
  WHERE "status" = 'PENDING';

-- A decided request says when it was decided.
ALTER TABLE "PlanRequest"
  ADD CONSTRAINT "PlanRequest_decided_requires_time"
  CHECK ("status" = 'PENDING' OR "decidedAt" IS NOT NULL);

-- Same policy as every other tenant table, in the form of 20260811000300: an
-- empty setting is treated as unset, so an unscoped query sees no rows rather
-- than raising on ''::uuid.
ALTER TABLE "PlanRequest" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PlanRequest"
  USING ("organizationId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
