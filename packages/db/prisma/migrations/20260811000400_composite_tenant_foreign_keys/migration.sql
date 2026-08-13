-- ────────────────────────────────────────────────────────────────────────────
-- Composite tenant foreign keys.
--
-- Every reference between two tenant-scoped tables now carries organizationId
-- alongside the child key, and points at a (organizationId, id) unique index on
-- the parent. A row that references a parent in another organization is
-- therefore rejected by the database itself, not merely by convention in the
-- service layer.
--
-- This closes the gap documented in packages/auth/src/cross-tenant.integration
-- .test.ts: the tenant-scoped client correctly stamps organizationId, but a
-- single-column brandId foreign key only checked that the brand *existed*.
--
-- Optional references (MediaAsset.brandId / .folderId, AIUsage.brandId,
-- Post.sourceIdeaId) use NO ACTION rather than SET NULL: SET NULL on a
-- composite key would try to null organizationId, which is NOT NULL. NO ACTION
-- is evaluated at end-of-statement, so a cascading organization delete that
-- removes parent and child together still succeeds.
--
-- Note: User references (createdById, assignedToId, uploadedById, …) cannot be
-- composite — a User genuinely spans organizations, so no (organizationId, id)
-- key exists for it. Those remain enforced at the application layer, which
-- checks membership before assigning.
-- ────────────────────────────────────────────────────────────────────────────
-- DropForeignKey
ALTER TABLE "AIUsage" DROP CONSTRAINT "AIUsage_brandId_fkey";

-- DropForeignKey
ALTER TABLE "AnalyticsSnapshot" DROP CONSTRAINT "AnalyticsSnapshot_socialAccountId_fkey";

-- DropForeignKey
ALTER TABLE "Approval" DROP CONSTRAINT "Approval_postId_fkey";

-- DropForeignKey
ALTER TABLE "Brand" DROP CONSTRAINT "Brand_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "BrandAssignment" DROP CONSTRAINT "BrandAssignment_brandId_fkey";

-- DropForeignKey
ALTER TABLE "BrandVoice" DROP CONSTRAINT "BrandVoice_brandId_fkey";

-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_parentId_fkey";

-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_postId_fkey";

-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_postVariantId_fkey";

-- DropForeignKey
ALTER TABLE "ContentIdea" DROP CONSTRAINT "ContentIdea_brandId_fkey";

-- DropForeignKey
ALTER TABLE "ContentIdea" DROP CONSTRAINT "ContentIdea_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "MediaAsset" DROP CONSTRAINT "MediaAsset_brandId_fkey";

-- DropForeignKey
ALTER TABLE "MediaAsset" DROP CONSTRAINT "MediaAsset_folderId_fkey";

-- DropForeignKey
ALTER TABLE "MediaAsset" DROP CONSTRAINT "MediaAsset_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "MediaFolder" DROP CONSTRAINT "MediaFolder_parentId_fkey";

-- DropForeignKey
ALTER TABLE "MediaFolder" DROP CONSTRAINT "MediaFolder_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "Post" DROP CONSTRAINT "Post_brandId_fkey";

-- DropForeignKey
ALTER TABLE "Post" DROP CONSTRAINT "Post_sourceIdeaId_fkey";

-- DropForeignKey
ALTER TABLE "Post" DROP CONSTRAINT "Post_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "PostAnalytics" DROP CONSTRAINT "PostAnalytics_postVariantId_fkey";

-- DropForeignKey
ALTER TABLE "PostMedia" DROP CONSTRAINT "PostMedia_mediaAssetId_fkey";

-- DropForeignKey
ALTER TABLE "PostMedia" DROP CONSTRAINT "PostMedia_postId_fkey";

-- DropForeignKey
ALTER TABLE "PostMedia" DROP CONSTRAINT "PostMedia_postVariantId_fkey";

-- DropForeignKey
ALTER TABLE "PostVariant" DROP CONSTRAINT "PostVariant_postId_fkey";

-- DropForeignKey
ALTER TABLE "PostVariant" DROP CONSTRAINT "PostVariant_socialAccountId_fkey";

-- DropForeignKey
ALTER TABLE "ProductionTask" DROP CONSTRAINT "ProductionTask_postId_fkey";

-- DropForeignKey
ALTER TABLE "PublishingAttempt" DROP CONSTRAINT "PublishingAttempt_publishingJobId_fkey";

-- DropForeignKey
ALTER TABLE "PublishingJob" DROP CONSTRAINT "PublishingJob_postVariantId_fkey";

-- DropForeignKey
ALTER TABLE "QueueSlot" DROP CONSTRAINT "QueueSlot_socialAccountId_fkey";

-- DropForeignKey
ALTER TABLE "QueueSlot" DROP CONSTRAINT "QueueSlot_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "SocialAccount" DROP CONSTRAINT "SocialAccount_brandId_fkey";

-- DropForeignKey
ALTER TABLE "SocialAccount" DROP CONSTRAINT "SocialAccount_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "SocialCredential" DROP CONSTRAINT "SocialCredential_socialAccountId_fkey";

-- DropForeignKey
ALTER TABLE "WorkspaceMembership" DROP CONSTRAINT "WorkspaceMembership_workspaceId_fkey";

-- DropIndex
DROP INDEX "MediaAsset_tags_gin";

-- CreateIndex
CREATE UNIQUE INDEX "Brand_organizationId_id_key" ON "Brand"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BrandVoice_organizationId_brandId_key" ON "BrandVoice"("organizationId", "brandId");

-- CreateIndex
CREATE UNIQUE INDEX "Comment_organizationId_id_key" ON "Comment"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ContentIdea_organizationId_id_key" ON "ContentIdea"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_organizationId_id_key" ON "MediaAsset"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MediaFolder_organizationId_id_key" ON "MediaFolder"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Post_organizationId_id_key" ON "Post"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PostVariant_organizationId_id_key" ON "PostVariant"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PublishingJob_organizationId_id_key" ON "PublishingJob"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_organizationId_id_key" ON "SocialAccount"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SocialCredential_organizationId_socialAccountId_key" ON "SocialCredential"("organizationId", "socialAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_organizationId_id_key" ON "Workspace"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_organizationId_workspaceId_fkey" FOREIGN KEY ("organizationId", "workspaceId") REFERENCES "Workspace"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_organizationId_workspaceId_fkey" FOREIGN KEY ("organizationId", "workspaceId") REFERENCES "Workspace"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandAssignment" ADD CONSTRAINT "BrandAssignment_organizationId_brandId_fkey" FOREIGN KEY ("organizationId", "brandId") REFERENCES "Brand"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_organizationId_workspaceId_fkey" FOREIGN KEY ("organizationId", "workspaceId") REFERENCES "Workspace"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_organizationId_brandId_fkey" FOREIGN KEY ("organizationId", "brandId") REFERENCES "Brand"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialCredential" ADD CONSTRAINT "SocialCredential_organizationId_socialAccountId_fkey" FOREIGN KEY ("organizationId", "socialAccountId") REFERENCES "SocialAccount"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_organizationId_workspaceId_fkey" FOREIGN KEY ("organizationId", "workspaceId") REFERENCES "Workspace"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_organizationId_brandId_fkey" FOREIGN KEY ("organizationId", "brandId") REFERENCES "Brand"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_organizationId_sourceIdeaId_fkey" FOREIGN KEY ("organizationId", "sourceIdeaId") REFERENCES "ContentIdea"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostVariant" ADD CONSTRAINT "PostVariant_organizationId_postId_fkey" FOREIGN KEY ("organizationId", "postId") REFERENCES "Post"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostVariant" ADD CONSTRAINT "PostVariant_organizationId_socialAccountId_fkey" FOREIGN KEY ("organizationId", "socialAccountId") REFERENCES "SocialAccount"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostMedia" ADD CONSTRAINT "PostMedia_organizationId_postId_fkey" FOREIGN KEY ("organizationId", "postId") REFERENCES "Post"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostMedia" ADD CONSTRAINT "PostMedia_organizationId_postVariantId_fkey" FOREIGN KEY ("organizationId", "postVariantId") REFERENCES "PostVariant"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostMedia" ADD CONSTRAINT "PostMedia_organizationId_mediaAssetId_fkey" FOREIGN KEY ("organizationId", "mediaAssetId") REFERENCES "MediaAsset"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_organizationId_workspaceId_fkey" FOREIGN KEY ("organizationId", "workspaceId") REFERENCES "Workspace"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_organizationId_brandId_fkey" FOREIGN KEY ("organizationId", "brandId") REFERENCES "Brand"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_organizationId_folderId_fkey" FOREIGN KEY ("organizationId", "folderId") REFERENCES "MediaFolder"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaFolder" ADD CONSTRAINT "MediaFolder_organizationId_workspaceId_fkey" FOREIGN KEY ("organizationId", "workspaceId") REFERENCES "Workspace"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaFolder" ADD CONSTRAINT "MediaFolder_organizationId_parentId_fkey" FOREIGN KEY ("organizationId", "parentId") REFERENCES "MediaFolder"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_organizationId_postId_fkey" FOREIGN KEY ("organizationId", "postId") REFERENCES "Post"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionTask" ADD CONSTRAINT "ProductionTask_organizationId_postId_fkey" FOREIGN KEY ("organizationId", "postId") REFERENCES "Post"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_organizationId_postId_fkey" FOREIGN KEY ("organizationId", "postId") REFERENCES "Post"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_organizationId_postVariantId_fkey" FOREIGN KEY ("organizationId", "postVariantId") REFERENCES "PostVariant"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_organizationId_parentId_fkey" FOREIGN KEY ("organizationId", "parentId") REFERENCES "Comment"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueSlot" ADD CONSTRAINT "QueueSlot_organizationId_workspaceId_fkey" FOREIGN KEY ("organizationId", "workspaceId") REFERENCES "Workspace"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueSlot" ADD CONSTRAINT "QueueSlot_organizationId_socialAccountId_fkey" FOREIGN KEY ("organizationId", "socialAccountId") REFERENCES "SocialAccount"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingJob" ADD CONSTRAINT "PublishingJob_organizationId_postVariantId_fkey" FOREIGN KEY ("organizationId", "postVariantId") REFERENCES "PostVariant"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingAttempt" ADD CONSTRAINT "PublishingAttempt_organizationId_publishingJobId_fkey" FOREIGN KEY ("organizationId", "publishingJobId") REFERENCES "PublishingJob"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostAnalytics" ADD CONSTRAINT "PostAnalytics_organizationId_postVariantId_fkey" FOREIGN KEY ("organizationId", "postVariantId") REFERENCES "PostVariant"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsSnapshot" ADD CONSTRAINT "AnalyticsSnapshot_organizationId_socialAccountId_fkey" FOREIGN KEY ("organizationId", "socialAccountId") REFERENCES "SocialAccount"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandVoice" ADD CONSTRAINT "BrandVoice_organizationId_brandId_fkey" FOREIGN KEY ("organizationId", "brandId") REFERENCES "Brand"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentIdea" ADD CONSTRAINT "ContentIdea_organizationId_workspaceId_fkey" FOREIGN KEY ("organizationId", "workspaceId") REFERENCES "Workspace"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentIdea" ADD CONSTRAINT "ContentIdea_organizationId_brandId_fkey" FOREIGN KEY ("organizationId", "brandId") REFERENCES "Brand"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIUsage" ADD CONSTRAINT "AIUsage_organizationId_brandId_fkey" FOREIGN KEY ("organizationId", "brandId") REFERENCES "Brand"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
