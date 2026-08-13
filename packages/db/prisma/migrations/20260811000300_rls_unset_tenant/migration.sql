-- ────────────────────────────────────────────────────────────────────────────
-- Fix: treat an *empty* app.current_org_id as unset.
--
-- `SET LOCAL` reverts at commit to the setting's prior value, which — once the
-- setting has been touched at all on a connection — is the empty string rather
-- than "not set". `current_setting('app.current_org_id', true)` therefore
-- returns NULL only on a pristine connection and '' on every reused one, and
-- ''::uuid raises 22P02.
--
-- The original policies were fail-closed (an error, not a leak), but on a
-- pooled connection every unscoped query would have errored instead of simply
-- returning no rows. NULLIF collapses both representations to NULL, so the
-- comparison is NULL and the row is filtered — the intended deny-by-default.
--
-- Caught by packages/db/src/rls.integration.test.ts, which reuses a connection
-- across transactions precisely to exercise this.
-- ────────────────────────────────────────────────────────────────────────────

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
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING ("organizationId" = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid)
         WITH CHECK ("organizationId" = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END
$$;

DROP POLICY IF EXISTS tenant_isolation ON "Organization";
CREATE POLICY tenant_isolation ON "Organization"
  USING ("id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
