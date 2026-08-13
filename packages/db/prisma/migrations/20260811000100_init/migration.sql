-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "OrganizationRole" AS ENUM ('OWNER', 'ADMIN', 'ACCOUNT_MANAGER', 'CONTENT_CREATOR', 'APPROVER', 'CLIENT');

-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('MANAGER', 'CONTRIBUTOR', 'APPROVER', 'CLIENT_VIEWER', 'CLIENT_APPROVER');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "WorkspaceStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'X', 'TIKTOK', 'YOUTUBE', 'THREADS', 'PINTEREST');

-- CreateEnum
CREATE TYPE "SocialAccountStatus" AS ENUM ('ACTIVE', 'NEEDS_RECONNECT', 'DISABLED', 'REVOKED');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('IDEA', 'DRAFT', 'INTERNAL_REVIEW', 'CLIENT_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'PARTIALLY_PUBLISHED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "VariantStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "PostSource" AS ENUM ('MANUAL', 'AI_IDEA', 'REPURPOSE');

-- CreateEnum
CREATE TYPE "ApprovalStage" AS ENUM ('INTERNAL', 'CLIENT');

-- CreateEnum
CREATE TYPE "ApprovalState" AS ENUM ('PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'CANCELED');

-- CreateEnum
CREATE TYPE "ProductionStage" AS ENUM ('IDEA', 'COPYWRITING', 'DESIGN', 'INTERNAL_REVIEW', 'CLIENT_REVIEW', 'SCHEDULING');

-- CreateEnum
CREATE TYPE "ProductionTaskState" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE');

-- CreateEnum
CREATE TYPE "CommentVisibility" AS ENUM ('INTERNAL', 'CLIENT_VISIBLE');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('IMAGE', 'VIDEO', 'GIF');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING', 'READY', 'REJECTED');

-- CreateEnum
CREATE TYPE "PublishingJobState" AS ENUM ('PENDING', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "PublishingAttemptState" AS ENUM ('IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'RECONCILED', 'INCONCLUSIVE');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'WORKER');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED');

-- CreateEnum
CREATE TYPE "ContentIdeaState" AS ENUM ('SUGGESTED', 'ACCEPTED', 'DISMISSED', 'CONVERTED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "firebaseUid" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoUrl" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMembership" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "OrganizationRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "invitedById" UUID,
    "invitedAt" TIMESTAMPTZ(3),
    "acceptedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "clientCompanyName" TEXT,
    "status" "WorkspaceStatus" NOT NULL DEFAULT 'ACTIVE',
    "clientUploadsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMembership" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "WorkspaceRole" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Brand" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoUrl" TEXT,
    "primaryColor" TEXT,
    "website" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandAssignment" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "canApprove" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrandAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialAccount" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "handle" TEXT,
    "displayName" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "accountType" TEXT,
    "status" "SocialAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "healthCheckedAt" TIMESTAMPTZ(3),
    "healthError" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "connectedById" UUID,
    "connectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialCredential" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "socialAccountId" UUID NOT NULL,
    "accessTokenCiphertext" BYTEA NOT NULL,
    "accessTokenIv" BYTEA NOT NULL,
    "accessTokenAuthTag" BYTEA NOT NULL,
    "refreshTokenCiphertext" BYTEA,
    "refreshTokenIv" BYTEA,
    "refreshTokenAuthTag" BYTEA,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMPTZ(3),
    "refreshableUntil" TIMESTAMPTZ(3),
    "lastRefreshedAt" TIMESTAMPTZ(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SocialCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Post" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL DEFAULT '',
    "status" "PostStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" UUID,
    "assignedToId" UUID,
    "approvalRequired" BOOLEAN NOT NULL DEFAULT true,
    "scheduledFor" TIMESTAMPTZ(3),
    "timezone" TEXT,
    "contentHash" TEXT,
    "source" "PostSource" NOT NULL DEFAULT 'MANUAL',
    "sourceIdeaId" UUID,
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostVariant" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "postId" UUID NOT NULL,
    "socialAccountId" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "firstComment" TEXT,
    "linkUrl" TEXT,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mentions" JSONB NOT NULL DEFAULT '[]',
    "platformOptions" JSONB NOT NULL DEFAULT '{}',
    "status" "VariantStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledFor" TIMESTAMPTZ(3),
    "claimedAt" TIMESTAMPTZ(3),
    "claimToken" TEXT,
    "externalPostId" TEXT,
    "externalPermalink" TEXT,
    "publishedAt" TIMESTAMPTZ(3),
    "lastError" JSONB,
    "contentHash" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "PostVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostMedia" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "postId" UUID NOT NULL,
    "postVariantId" UUID,
    "mediaAssetId" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "altText" TEXT,

    CONSTRAINT "PostMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID,
    "folderId" UUID,
    "kind" "MediaKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "checksum" TEXT,
    "originalFilename" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "uploadedById" UUID,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaFolder" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "parentId" UUID,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "postId" UUID NOT NULL,
    "stage" "ApprovalStage" NOT NULL,
    "state" "ApprovalState" NOT NULL DEFAULT 'PENDING',
    "requestedById" UUID,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "comment" TEXT,
    "round" INTEGER NOT NULL DEFAULT 1,
    "onBehalfOf" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionTask" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "postId" UUID NOT NULL,
    "stage" "ProductionStage" NOT NULL,
    "state" "ProductionTaskState" NOT NULL DEFAULT 'TODO',
    "assigneeId" UUID,
    "dueAt" TIMESTAMPTZ(3),
    "blocking" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProductionTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "postId" UUID NOT NULL,
    "postVariantId" UUID,
    "parentId" UUID,
    "authorId" UUID,
    "body" TEXT NOT NULL,
    "mentionedUserIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "visibility" "CommentVisibility" NOT NULL DEFAULT 'INTERNAL',
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueueSlot" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "socialAccountId" UUID,
    "dayOfWeek" INTEGER NOT NULL,
    "localTime" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QueueSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishingJob" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "postVariantId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "scheduledFor" TIMESTAMPTZ(3) NOT NULL,
    "state" "PublishingJobState" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 4,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "queueJobId" TEXT,
    "lastErrorCode" TEXT,
    "canceledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PublishingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishingAttempt" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "publishingJobId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "state" "PublishingAttemptState" NOT NULL DEFAULT 'IN_FLIGHT',
    "correlationId" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "durationMs" INTEGER,
    "externalPostId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "errorRetryable" BOOLEAN,
    "providerMeta" JSONB,
    "httpStatus" INTEGER,

    CONSTRAINT "PublishingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostAnalytics" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "postVariantId" UUID NOT NULL,
    "capturedAt" TIMESTAMPTZ(3) NOT NULL,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "availability" JSONB NOT NULL DEFAULT '{}',
    "providerApiVersion" TEXT NOT NULL,

    CONSTRAINT "PostAnalytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsSnapshot" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "socialAccountId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "availability" JSONB NOT NULL DEFAULT '{}',
    "providerApiVersion" TEXT NOT NULL,

    CONSTRAINT "AnalyticsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandVoice" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "companyDescription" TEXT,
    "productsServices" TEXT,
    "targetAudience" TEXT,
    "brandVoice" TEXT,
    "tone" TEXT,
    "preferredTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bannedTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ctas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "website" TEXT,
    "exampleContent" JSONB NOT NULL DEFAULT '[]',
    "socialInfo" JSONB NOT NULL DEFAULT '{}',
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BrandVoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentIdea" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "hook" TEXT,
    "platform" "Platform",
    "format" TEXT,
    "caption" TEXT,
    "cta" TEXT,
    "plannedFor" TIMESTAMPTZ(3),
    "state" "ContentIdeaState" NOT NULL DEFAULT 'SUGGESTED',
    "generatedById" UUID,
    "generationId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ContentIdea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIUsage" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "userId" UUID,
    "brandId" UUID,
    "operation" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costEstimate" DECIMAL(12,6),
    "latencyMs" INTEGER,
    "succeeded" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "resourceType" TEXT,
    "resourceId" UUID,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'IN_APP',
    "readAt" TIMESTAMPTZ(3),
    "emailedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "actorUserId" UUID,
    "actorType" "ActorType" NOT NULL DEFAULT 'USER',
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" UUID,
    "workspaceId" UUID,
    "brandId" UUID,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "correlationId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'trial',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "currentPeriodEnd" TIMESTAMPTZ(3),
    "seats" INTEGER NOT NULL DEFAULT 5,
    "limits" JSONB NOT NULL DEFAULT '{}',
    "canceledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrganizationRole" NOT NULL,
    "workspaceIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "invitedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "provider" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "signatureValid" BOOLEAN NOT NULL,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMPTZ(3),
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_firebaseUid_key" ON "User"("firebaseUid");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_isPlatformAdmin_idx" ON "User"("isPlatformAdmin");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "Organization_slug_idx" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "Organization_deletedAt_idx" ON "Organization"("deletedAt");

-- CreateIndex
CREATE INDEX "OrganizationMembership_organizationId_role_idx" ON "OrganizationMembership"("organizationId", "role");

-- CreateIndex
CREATE INDEX "OrganizationMembership_userId_idx" ON "OrganizationMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMembership_organizationId_userId_key" ON "OrganizationMembership"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "Workspace_organizationId_status_idx" ON "Workspace"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Workspace_organizationId_deletedAt_idx" ON "Workspace"("organizationId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_organizationId_slug_key" ON "Workspace"("organizationId", "slug");

-- CreateIndex
CREATE INDEX "WorkspaceMembership_organizationId_idx" ON "WorkspaceMembership"("organizationId");

-- CreateIndex
CREATE INDEX "WorkspaceMembership_userId_idx" ON "WorkspaceMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMembership_workspaceId_userId_key" ON "WorkspaceMembership"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "Brand_organizationId_idx" ON "Brand"("organizationId");

-- CreateIndex
CREATE INDEX "Brand_workspaceId_deletedAt_idx" ON "Brand"("workspaceId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_workspaceId_slug_key" ON "Brand"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "BrandAssignment_organizationId_idx" ON "BrandAssignment"("organizationId");

-- CreateIndex
CREATE INDEX "BrandAssignment_userId_idx" ON "BrandAssignment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandAssignment_brandId_userId_key" ON "BrandAssignment"("brandId", "userId");

-- CreateIndex
CREATE INDEX "SocialAccount_organizationId_status_idx" ON "SocialAccount"("organizationId", "status");

-- CreateIndex
CREATE INDEX "SocialAccount_brandId_deletedAt_idx" ON "SocialAccount"("brandId", "deletedAt");

-- CreateIndex
CREATE INDEX "SocialAccount_workspaceId_idx" ON "SocialAccount"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_organizationId_platform_externalId_key" ON "SocialAccount"("organizationId", "platform", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialCredential_socialAccountId_key" ON "SocialCredential"("socialAccountId");

-- CreateIndex
CREATE INDEX "SocialCredential_organizationId_idx" ON "SocialCredential"("organizationId");

-- CreateIndex
CREATE INDEX "Post_organizationId_workspaceId_status_scheduledFor_idx" ON "Post"("organizationId", "workspaceId", "status", "scheduledFor");

-- CreateIndex
CREATE INDEX "Post_brandId_status_idx" ON "Post"("brandId", "status");

-- CreateIndex
CREATE INDEX "Post_assignedToId_status_idx" ON "Post"("assignedToId", "status");

-- CreateIndex
CREATE INDEX "Post_organizationId_deletedAt_idx" ON "Post"("organizationId", "deletedAt");

-- CreateIndex
CREATE INDEX "PostVariant_status_scheduledFor_idx" ON "PostVariant"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "PostVariant_socialAccountId_publishedAt_idx" ON "PostVariant"("socialAccountId", "publishedAt");

-- CreateIndex
CREATE INDEX "PostVariant_externalPostId_idx" ON "PostVariant"("externalPostId");

-- CreateIndex
CREATE INDEX "PostVariant_organizationId_idx" ON "PostVariant"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PostVariant_postId_socialAccountId_key" ON "PostVariant"("postId", "socialAccountId");

-- CreateIndex
CREATE INDEX "PostMedia_postId_position_idx" ON "PostMedia"("postId", "position");

-- CreateIndex
CREATE INDEX "PostMedia_organizationId_idx" ON "PostMedia"("organizationId");

-- CreateIndex
CREATE INDEX "PostMedia_mediaAssetId_idx" ON "PostMedia"("mediaAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "PostMedia_postVariantId_mediaAssetId_position_key" ON "PostMedia"("postVariantId", "mediaAssetId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_storageKey_key" ON "MediaAsset"("storageKey");

-- CreateIndex
CREATE INDEX "MediaAsset_organizationId_workspaceId_kind_createdAt_idx" ON "MediaAsset"("organizationId", "workspaceId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "MediaAsset_organizationId_status_idx" ON "MediaAsset"("organizationId", "status");

-- CreateIndex
CREATE INDEX "MediaAsset_folderId_idx" ON "MediaAsset"("folderId");

-- CreateIndex
CREATE INDEX "MediaFolder_organizationId_idx" ON "MediaFolder"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaFolder_workspaceId_parentId_name_key" ON "MediaFolder"("workspaceId", "parentId", "name");

-- CreateIndex
CREATE INDEX "Approval_postId_stage_state_idx" ON "Approval"("postId", "stage", "state");

-- CreateIndex
CREATE INDEX "Approval_organizationId_state_idx" ON "Approval"("organizationId", "state");

-- CreateIndex
CREATE INDEX "ProductionTask_organizationId_state_idx" ON "ProductionTask"("organizationId", "state");

-- CreateIndex
CREATE INDEX "ProductionTask_assigneeId_state_idx" ON "ProductionTask"("assigneeId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionTask_postId_stage_key" ON "ProductionTask"("postId", "stage");

-- CreateIndex
CREATE INDEX "Comment_postId_createdAt_idx" ON "Comment"("postId", "createdAt");

-- CreateIndex
CREATE INDEX "Comment_organizationId_visibility_idx" ON "Comment"("organizationId", "visibility");

-- CreateIndex
CREATE INDEX "QueueSlot_organizationId_workspaceId_isActive_idx" ON "QueueSlot"("organizationId", "workspaceId", "isActive");

-- CreateIndex
CREATE INDEX "PublishingJob_state_nextAttemptAt_idx" ON "PublishingJob"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "PublishingJob_organizationId_state_idx" ON "PublishingJob"("organizationId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "PublishingJob_postVariantId_idempotencyKey_key" ON "PublishingJob"("postVariantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PublishingAttempt_organizationId_state_idx" ON "PublishingAttempt"("organizationId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "PublishingAttempt_publishingJobId_attemptNumber_key" ON "PublishingAttempt"("publishingJobId", "attemptNumber");

-- CreateIndex
CREATE INDEX "PostAnalytics_organizationId_idx" ON "PostAnalytics"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PostAnalytics_postVariantId_capturedAt_key" ON "PostAnalytics"("postVariantId", "capturedAt");

-- CreateIndex
CREATE INDEX "AnalyticsSnapshot_organizationId_idx" ON "AnalyticsSnapshot"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsSnapshot_socialAccountId_date_key" ON "AnalyticsSnapshot"("socialAccountId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "BrandVoice_brandId_key" ON "BrandVoice"("brandId");

-- CreateIndex
CREATE INDEX "BrandVoice_organizationId_idx" ON "BrandVoice"("organizationId");

-- CreateIndex
CREATE INDEX "ContentIdea_organizationId_state_idx" ON "ContentIdea"("organizationId", "state");

-- CreateIndex
CREATE INDEX "ContentIdea_brandId_plannedFor_idx" ON "ContentIdea"("brandId", "plannedFor");

-- CreateIndex
CREATE INDEX "AIUsage_organizationId_createdAt_idx" ON "AIUsage"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_organizationId_idx" ON "Notification"("organizationId");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_resourceType_resourceId_idx" ON "AuditLog"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_organizationId_key" ON "Subscription"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_organizationId_email_idx" ON "Invitation"("organizationId", "email");

-- CreateIndex
CREATE INDEX "Invitation_expiresAt_idx" ON "Invitation"("expiresAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_processedAt_idx" ON "WebhookEvent"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_externalEventId_key" ON "WebhookEvent"("provider", "externalEventId");

-- AddForeignKey
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandAssignment" ADD CONSTRAINT "BrandAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandAssignment" ADD CONSTRAINT "BrandAssignment_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandAssignment" ADD CONSTRAINT "BrandAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialCredential" ADD CONSTRAINT "SocialCredential_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialCredential" ADD CONSTRAINT "SocialCredential_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_sourceIdeaId_fkey" FOREIGN KEY ("sourceIdeaId") REFERENCES "ContentIdea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostVariant" ADD CONSTRAINT "PostVariant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostVariant" ADD CONSTRAINT "PostVariant_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostVariant" ADD CONSTRAINT "PostVariant_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostMedia" ADD CONSTRAINT "PostMedia_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostMedia" ADD CONSTRAINT "PostMedia_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostMedia" ADD CONSTRAINT "PostMedia_postVariantId_fkey" FOREIGN KEY ("postVariantId") REFERENCES "PostVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostMedia" ADD CONSTRAINT "PostMedia_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "MediaFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaFolder" ADD CONSTRAINT "MediaFolder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaFolder" ADD CONSTRAINT "MediaFolder_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaFolder" ADD CONSTRAINT "MediaFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "MediaFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionTask" ADD CONSTRAINT "ProductionTask_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionTask" ADD CONSTRAINT "ProductionTask_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionTask" ADD CONSTRAINT "ProductionTask_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_postVariantId_fkey" FOREIGN KEY ("postVariantId") REFERENCES "PostVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueSlot" ADD CONSTRAINT "QueueSlot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueSlot" ADD CONSTRAINT "QueueSlot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueSlot" ADD CONSTRAINT "QueueSlot_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingJob" ADD CONSTRAINT "PublishingJob_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingJob" ADD CONSTRAINT "PublishingJob_postVariantId_fkey" FOREIGN KEY ("postVariantId") REFERENCES "PostVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingAttempt" ADD CONSTRAINT "PublishingAttempt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingAttempt" ADD CONSTRAINT "PublishingAttempt_publishingJobId_fkey" FOREIGN KEY ("publishingJobId") REFERENCES "PublishingJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostAnalytics" ADD CONSTRAINT "PostAnalytics_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostAnalytics" ADD CONSTRAINT "PostAnalytics_postVariantId_fkey" FOREIGN KEY ("postVariantId") REFERENCES "PostVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsSnapshot" ADD CONSTRAINT "AnalyticsSnapshot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsSnapshot" ADD CONSTRAINT "AnalyticsSnapshot_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandVoice" ADD CONSTRAINT "BrandVoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandVoice" ADD CONSTRAINT "BrandVoice_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandVoice" ADD CONSTRAINT "BrandVoice_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentIdea" ADD CONSTRAINT "ContentIdea_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentIdea" ADD CONSTRAINT "ContentIdea_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentIdea" ADD CONSTRAINT "ContentIdea_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentIdea" ADD CONSTRAINT "ContentIdea_generatedById_fkey" FOREIGN KEY ("generatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIUsage" ADD CONSTRAINT "AIUsage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIUsage" ADD CONSTRAINT "AIUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIUsage" ADD CONSTRAINT "AIUsage_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

