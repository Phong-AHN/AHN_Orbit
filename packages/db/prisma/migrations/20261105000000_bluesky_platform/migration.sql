-- Bluesky joins the platforms an account can be connected on (D-112).
--
-- Additive only: a new enum value, nothing renamed or removed, so it is safe
-- to apply ahead of the code that uses it. Postgres 12+ allows ADD VALUE in a
-- transaction as long as the value is not used in that same transaction.
ALTER TYPE "Platform" ADD VALUE IF NOT EXISTS 'BLUESKY';
