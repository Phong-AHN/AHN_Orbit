-- ────────────────────────────────────────────────────────────────────────────
-- Integrity constraints, partial indexes, and row-level security.
--
-- RLS is the *backstop*, not the primary control (decision D-005). The primary
-- control is the tenant-scoped Prisma client, which injects organizationId into
-- every query. This layer exists so that a bug in that layer is contained
-- rather than becoming a breach.
--
-- Enforcement model: policies compare against `app.current_org_id`, a
-- transaction-local setting the client issues via SET LOCAL inside the
-- transaction it opens. Unset ⇒ current_setting(..., true) is NULL ⇒ every
-- comparison is NULL ⇒ no rows. Deny by default.
--
-- The table owner (the migration role) bypasses RLS, which is what lets
-- migrations and the seed script run. The application connects as `orbit_app`,
-- a non-owner, so RLS applies to it.
-- ────────────────────────────────────────────────────────────────────────────

-- ── Check constraints (docs/DATABASE.md §5) ─────────────────────────────────

ALTER TABLE "PostVariant"
  ADD CONSTRAINT "PostVariant_scheduled_requires_time"
  CHECK ("status" <> 'SCHEDULED' OR "scheduledFor" IS NOT NULL);

ALTER TABLE "PostVariant"
  ADD CONSTRAINT "PostVariant_published_requires_external_id"
  CHECK ("status" <> 'PUBLISHED' OR "externalPostId" IS NOT NULL);

ALTER TABLE "Post"
  ADD CONSTRAINT "Post_published_requires_timestamp"
  CHECK ("status" <> 'PUBLISHED' OR "publishedAt" IS NOT NULL);

ALTER TABLE "QueueSlot"
  ADD CONSTRAINT "QueueSlot_day_of_week_range"
  CHECK ("dayOfWeek" BETWEEN 0 AND 6);

ALTER TABLE "QueueSlot"
  ADD CONSTRAINT "QueueSlot_local_time_format"
  CHECK ("localTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

ALTER TABLE "MediaAsset"
  ADD CONSTRAINT "MediaAsset_non_negative_size"
  CHECK ("sizeBytes" >= 0);

ALTER TABLE "MediaAsset"
  ADD CONSTRAINT "MediaAsset_rejected_requires_reason"
  CHECK ("status" <> 'REJECTED' OR "rejectionReason" IS NOT NULL);

ALTER TABLE "PublishingJob"
  ADD CONSTRAINT "PublishingJob_attempts_within_max"
  CHECK ("attemptCount" >= 0 AND "attemptCount" <= "maxAttempts");

ALTER TABLE "PublishingAttempt"
  ADD CONSTRAINT "PublishingAttempt_number_positive"
  CHECK ("attemptNumber" >= 1);

-- ── Partial indexes and uniques ─────────────────────────────────────────────

-- The 30s scheduler sweep. Partial so the index stays small no matter how many
-- posts have already been published (docs/ARCHITECTURE.md §5.1).
CREATE INDEX "PostVariant_due_for_publish_idx"
  ON "PostVariant" ("scheduledFor")
  WHERE "status" = 'SCHEDULED' AND "deletedAt" IS NULL;

-- Retry sweep over jobs waiting to be re-attempted.
CREATE INDEX "PublishingJob_retry_due_idx"
  ON "PublishingJob" ("nextAttemptAt")
  WHERE "state" IN ('PENDING', 'FAILED');

-- One open approval request per stage. Enforced here rather than in application
-- code, where a race can defeat it.
CREATE UNIQUE INDEX "Approval_one_open_per_stage"
  ON "Approval" ("postId", "stage")
  WHERE "state" = 'PENDING';

-- Only one active (non-deleted) connection per Page per organization.
CREATE UNIQUE INDEX "SocialAccount_one_live_connection"
  ON "SocialAccount" ("organizationId", "platform", "externalId")
  WHERE "deletedAt" IS NULL;

-- Media library search (docs/DATABASE.md §4).
CREATE INDEX "MediaAsset_tags_gin" ON "MediaAsset" USING GIN ("tags");
CREATE INDEX "MediaAsset_filename_fts"
  ON "MediaAsset" USING GIN (to_tsvector('simple', coalesce("originalFilename", '')));

-- Unread notification bell.
CREATE INDEX "Notification_unread_idx"
  ON "Notification" ("userId", "createdAt" DESC)
  WHERE "readAt" IS NULL;

-- Accounts needing attention, for the dashboard alert list (SRS §20).
CREATE INDEX "SocialAccount_unhealthy_idx"
  ON "SocialAccount" ("organizationId", "status")
  WHERE "status" <> 'ACTIVE' AND "deletedAt" IS NULL;

-- ── Application role ────────────────────────────────────────────────────────
-- Created NOLOGIN and without a password. Each environment grants LOGIN and a
-- credential out of band (see docs/DEPLOYMENT.md) so no secret lives in a
-- migration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orbit_app') THEN
    CREATE ROLE orbit_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO orbit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO orbit_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO orbit_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO orbit_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO orbit_app;

-- The audit log is append-only: the application may write history but never
-- rewrite it, so the log cannot drift from what actually happened (SRS §16).
REVOKE UPDATE, DELETE ON "AuditLog" FROM orbit_app;

-- ── Row-level security ──────────────────────────────────────────────────────

-- Every table carrying organizationId gets the identical policy.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'OrganizationMembership', 'Workspace', 'WorkspaceMembership', 'Brand',
    'BrandAssignment', 'SocialAccount', 'SocialCredential', 'Post',
    'PostVariant', 'PostMedia', 'MediaAsset', 'MediaFolder', 'Approval',
    'ProductionTask', 'Comment', 'QueueSlot', 'PublishingJob',
    'PublishingAttempt', 'PostAnalytics', 'AnalyticsSnapshot', 'BrandVoice',
    'ContentIdea', 'AIUsage', 'Notification', 'AuditLog', 'Subscription',
    'Invitation'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING ("organizationId" = current_setting(''app.current_org_id'', true)::uuid)
         WITH CHECK ("organizationId" = current_setting(''app.current_org_id'', true)::uuid)',
      t
    );
  END LOOP;
END
$$;

-- The tenant root keys on its own id rather than an organizationId column.
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Organization"
  USING ("id" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("id" = current_setting('app.current_org_id', true)::uuid);

-- "User" and "WebhookEvent" are deliberately NOT tenant-scoped:
--   • a user may hold memberships in several organizations, so the row itself
--     belongs to no single tenant — reachability is decided by membership;
--   • webhook events arrive before a tenant is known, and the tenant is
--     resolved through our own account mapping, never from the payload.
