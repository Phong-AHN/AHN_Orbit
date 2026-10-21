-- D-106: whether a workspace has a client who approves its posts.
--
-- Additive and safe to apply to a live database: one column, NOT NULL with a
-- default, so existing rows are filled in place and nothing that reads the
-- table changes behaviour.
--
-- The default is TRUE deliberately. Every existing workspace keeps its client
-- gate exactly as it works today; an agency's own workspace has to be marked
-- internal on purpose, by an organization-level Owner or Admin, rather than
-- arriving there by omission.

ALTER TABLE "Workspace"
  ADD COLUMN "requiresClientApproval" BOOLEAN NOT NULL DEFAULT true;
