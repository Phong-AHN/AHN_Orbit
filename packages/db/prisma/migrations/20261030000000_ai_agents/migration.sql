-- ────────────────────────────────────────────────────────────────────────────
-- AI agents acting for a person (D-109, docs/AGENT-MCP-PLAN.md).
--
-- - AgentClient: MCP clients registered with the authorization server.
--   Platform-level — software, not a tenant's data — so no organizationId and
--   no RLS, like User.
-- - AgentAuthorizationCode, AgentGrant, AgentToken: OAuth 2.1 with PKCE.
--   Only hashes of codes and tokens are stored. A grant binds one person, one
--   client and one organization to a set of scopes; the person's role is still
--   read fresh on every call, so scopes can only narrow it.
-- - AgentAction: an outward action (publish, schedule, reply…) an agent
--   prepared, which runs only after the person confirms it outside the model.
--
-- Tenant isolation as everywhere else: composite foreign keys, and RLS.
-- ────────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "AgentChannel" AS ENUM ('MCP', 'COPILOT');

-- CreateEnum
CREATE TYPE "AgentTokenKind" AS ENUM ('ACCESS', 'REFRESH');

-- CreateEnum
CREATE TYPE "AgentActionStatus" AS ENUM ('PENDING', 'EXECUTING', 'EXECUTED', 'FAILED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "AgentClient" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AgentClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentAuthorizationCode" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "clientId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "scopes" TEXT[],
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentAuthorizationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentGrant" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "scopes" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "revokedById" UUID,
    "revokedReason" TEXT,

    CONSTRAINT "AgentGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentToken" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "kind" "AgentTokenKind" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentAction" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channel" "AgentChannel" NOT NULL,
    "grantId" UUID,
    "tool" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "AgentActionStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "decidedAt" TIMESTAMPTZ(3),
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentClient_clientId_key" ON "AgentClient"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentAuthorizationCode_codeHash_key" ON "AgentAuthorizationCode"("codeHash");

-- CreateIndex
CREATE INDEX "AgentAuthorizationCode_expiresAt_idx" ON "AgentAuthorizationCode"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentAuthorizationCode_organizationId_id_key" ON "AgentAuthorizationCode"("organizationId", "id");

-- CreateIndex
CREATE INDEX "AgentGrant_organizationId_userId_idx" ON "AgentGrant"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentGrant_organizationId_id_key" ON "AgentGrant"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentToken_tokenHash_key" ON "AgentToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AgentToken_organizationId_grantId_idx" ON "AgentToken"("organizationId", "grantId");

-- CreateIndex
CREATE INDEX "AgentToken_expiresAt_idx" ON "AgentToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentToken_organizationId_id_key" ON "AgentToken"("organizationId", "id");

-- CreateIndex
CREATE INDEX "AgentAction_organizationId_userId_status_idx" ON "AgentAction"("organizationId", "userId", "status");

-- CreateIndex
CREATE INDEX "AgentAction_expiresAt_idx" ON "AgentAction"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentAction_organizationId_id_key" ON "AgentAction"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "AgentAuthorizationCode" ADD CONSTRAINT "AgentAuthorizationCode_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAuthorizationCode" ADD CONSTRAINT "AgentAuthorizationCode_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "AgentClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAuthorizationCode" ADD CONSTRAINT "AgentAuthorizationCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentGrant" ADD CONSTRAINT "AgentGrant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentGrant" ADD CONSTRAINT "AgentGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentGrant" ADD CONSTRAINT "AgentGrant_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "AgentClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentGrant" ADD CONSTRAINT "AgentGrant_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentToken" ADD CONSTRAINT "AgentToken_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentToken" ADD CONSTRAINT "AgentToken_organizationId_grantId_fkey" FOREIGN KEY ("organizationId", "grantId") REFERENCES "AgentGrant"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAction" ADD CONSTRAINT "AgentAction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAction" ADD CONSTRAINT "AgentAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAction" ADD CONSTRAINT "AgentAction_organizationId_grantId_fkey" FOREIGN KEY ("organizationId", "grantId") REFERENCES "AgentGrant"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Scopes are a closed set (`AGENT_SCOPES` in @orbit/core); anything else
-- stored here would be a scope no code knows how to narrow.
ALTER TABLE "AgentGrant"
  ADD CONSTRAINT "AgentGrant_scopes_known"
  CHECK ("scopes" <@ ARRAY['read', 'content', 'workflow', 'engagement']::TEXT[] AND cardinality("scopes") > 0);

ALTER TABLE "AgentAuthorizationCode"
  ADD CONSTRAINT "AgentAuthorizationCode_scopes_known"
  CHECK ("scopes" <@ ARRAY['read', 'content', 'workflow', 'engagement']::TEXT[] AND cardinality("scopes") > 0);

-- An S256 challenge is 43 base64url characters; anything else is not one.
ALTER TABLE "AgentAuthorizationCode"
  ADD CONSTRAINT "AgentAuthorizationCode_challenge_is_s256"
  CHECK ("codeChallenge" ~ '^[A-Za-z0-9_-]{43}$');

-- An MCP action carries the grant it came in on; a Copilot action has none.
ALTER TABLE "AgentAction"
  ADD CONSTRAINT "AgentAction_grant_matches_channel"
  CHECK (("channel" = 'MCP') = ("grantId" IS NOT NULL));

-- Same policy as every other tenant table (see 20260811000200).
ALTER TABLE "AgentAuthorizationCode" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AgentAuthorizationCode"
  USING ("organizationId" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("organizationId" = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE "AgentGrant" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AgentGrant"
  USING ("organizationId" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("organizationId" = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE "AgentToken" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AgentToken"
  USING ("organizationId" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("organizationId" = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE "AgentAction" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AgentAction"
  USING ("organizationId" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("organizationId" = current_setting('app.current_org_id', true)::uuid);
