-- Local development and CI only.
--
-- The migration creates `orbit_app` as NOLOGIN with no password, because a
-- credential must never live in a migration. Each real environment grants
-- LOGIN out of band (see docs/DEPLOYMENT.md). This file does it for the
-- throwaway local database so RLS can actually be exercised — the application
-- must connect as a NON-OWNER for policies to apply at all.

ALTER ROLE orbit_app WITH LOGIN PASSWORD 'orbit_local_dev';

GRANT USAGE ON SCHEMA public TO orbit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO orbit_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO orbit_app;

-- Append-only audit log (SRS §16): re-asserted here because the blanket grant
-- above would otherwise hand back what the migration deliberately revoked.
REVOKE UPDATE, DELETE ON "AuditLog" FROM orbit_app;
