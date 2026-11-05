-- Lift plan limits for every organization that exists today (D-113).
--
-- The product is operating internally, so the trial caps on clients, connected
-- accounts, AI credits and storage only get in the way. An empty `limits` means
-- "no limit" at every check: each one reads a key and skips when it is absent.
--
-- Data, not schema, and deliberately only the rows that exist now. Organizations
-- created later still start on DEFAULT_TRIAL_LIMITS, because anybody can sign up
-- and an open limit there would be unmetered AI and storage for strangers.
--
-- Reversible: each organization's previous limits are kept in its audit log
-- (`subscription.limits_lifted`, in `before`).
WITH lifted AS (
  SELECT "id", "organizationId", "limits" AS previous
  FROM "Subscription"
  WHERE "limits" <> '{}'::jsonb
),
audited AS (
  INSERT INTO "AuditLog" (
    "organizationId", "actorType", "action", "resourceType", "resourceId", "before", "after", "reason"
  )
  SELECT
    "organizationId",
    'SYSTEM'::"ActorType",
    'subscription.limits_lifted',
    'Subscription',
    "id",
    jsonb_build_object('limits', previous),
    jsonb_build_object('limits', '{}'::jsonb),
    'Internal operation: plan limits lifted for existing organizations (D-113).'
  FROM lifted
  RETURNING 1
)
UPDATE "Subscription" AS subscription
SET "limits" = '{}'::jsonb, "updatedAt" = CURRENT_TIMESTAMP
FROM lifted
WHERE subscription."id" = lifted."id";

-- Fail the whole migration rather than report success with rows still capped,
-- which is what would happen if row security hid any of them from this role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Subscription" WHERE "limits" <> '{}'::jsonb) THEN
    RAISE EXCEPTION 'Some subscriptions still carry plan limits';
  END IF;
END $$;
