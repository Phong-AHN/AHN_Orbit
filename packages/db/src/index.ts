export { platformDb, disconnect } from './client.js';
export {
  withTenant,
  withTenantRaw,
  TENANT_MODELS,
  TENANT_ROOT_MODEL,
  type TenantDb,
  type WithTenantOptions,
} from './tenant.js';
export { applyTenantScope, TENANT_FIELD } from './tenant-scope.js';

export { Prisma } from '@prisma/client';
export type {
  User,
  Organization,
  OrganizationMembership,
  Workspace,
  WorkspaceMembership,
  Brand,
  BrandAssignment,
  SocialAccount,
  SocialCredential,
  Post,
  PostVariant,
  PostMedia,
  MediaAsset,
  MediaFolder,
  Approval,
  ProductionTask,
  Comment,
  QueueSlot,
  PublishingJob,
  PublishingAttempt,
  PostAnalytics,
  AnalyticsSnapshot,
  BrandVoice,
  ContentIdea,
  AIUsage,
  Notification,
  AuditLog,
  Subscription,
  Invitation,
  WebhookEvent,
} from '@prisma/client';
