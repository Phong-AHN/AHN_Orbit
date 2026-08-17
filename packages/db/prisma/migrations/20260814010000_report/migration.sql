-- ────────────────────────────────────────────────────────────────────────────
-- Client reports (SRS §19, T3.5).
--
-- A row is a *record of a request*, not a file. The bytes live in S3 and the
-- key never leaves the server — callers receive a short-lived signed URL, so a
-- report cannot be fetched by guessing an id and cannot be fetched at all once
-- `expiresAt` has passed.
--
-- Tenant isolation follows the same two layers as every other table here: the
-- composite foreign key means a report cannot name a workspace in another
-- organization, and RLS means it cannot be read from one.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TYPE "ReportStatus" AS ENUM ('QUEUED', 'RENDERING', 'READY', 'FAILED');
CREATE TYPE "ReportFormat" AS ENUM ('CSV');

CREATE TABLE "Report" (
    "id"             UUID         NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID         NOT NULL,
    "workspaceId"    UUID,
    "status"         "ReportStatus" NOT NULL DEFAULT 'QUEUED',
    "format"         "ReportFormat" NOT NULL DEFAULT 'CSV',
    "parameters"     JSONB        NOT NULL DEFAULT '{}',
    "storageKey"     TEXT,
    "sizeBytes"      INTEGER,
    "failureCode"    TEXT,
    "failureMessage" TEXT,
    "expiresAt"      TIMESTAMPTZ(3) NOT NULL,
    "requestedById"  UUID,
    "createdAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- The composite key other tenant-scoped tables point at, kept for consistency
-- even though nothing references Report yet — the next thing that does will
-- find it already there.
CREATE UNIQUE INDEX "Report_organizationId_id_key" ON "Report"("organizationId", "id");
CREATE INDEX "Report_organizationId_createdAt_idx" ON "Report"("organizationId", "createdAt");

-- Drives the expiry sweep, whenever one is written: finding what has lapsed
-- must not mean scanning every report ever generated.
CREATE INDEX "Report_status_expiresAt_idx" ON "Report"("status", "expiresAt");

ALTER TABLE "Report"
  ADD CONSTRAINT "Report_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite, so a report cannot name a workspace belonging to someone else.
-- NO ACTION rather than SET NULL for the same reason as the other optional
-- composite references: SET NULL would try to null organizationId, which is
-- NOT NULL. NO ACTION is evaluated at end-of-statement, so a cascading
-- organization delete that removes both still succeeds.
ALTER TABLE "Report"
  ADD CONSTRAINT "Report_organizationId_workspaceId_fkey"
  FOREIGN KEY ("organizationId", "workspaceId") REFERENCES "Workspace"("organizationId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- A User spans organizations, so this one cannot be composite. SET NULL: the
-- report outlives the person who asked for it, and losing the requester is
-- better than losing the record.
ALTER TABLE "Report"
  ADD CONSTRAINT "Report_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Same policy as every other tenant table (see 20260811000200).
ALTER TABLE "Report" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Report"
  USING ("organizationId" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("organizationId" = current_setting('app.current_org_id', true)::uuid);
