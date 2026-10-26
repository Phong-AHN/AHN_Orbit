/**
 * Domain enumerations.
 *
 * These are the single source of truth and are mirrored into the Prisma schema
 * as Postgres enums. `packages/db/src/enum-drift.test.ts` parses schema.prisma
 * and fails if the two ever diverge — so mirroring cannot rot silently.
 */

export const ORGANIZATION_ROLES = [
  'OWNER',
  'ADMIN',
  'ACCOUNT_MANAGER',
  'CONTENT_CREATOR',
  'APPROVER',
  'CLIENT',
] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const WORKSPACE_ROLES = [
  'MANAGER',
  'CONTRIBUTOR',
  'APPROVER',
  'CLIENT_VIEWER',
  'CLIENT_APPROVER',
] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const MEMBERSHIP_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/**
 * Facebook Pages is the only launch platform (SRS §51). The rest are declared
 * so the schema, capability matrix, and registry are plural from day one
 * (assumption C13) — but no adapter exists for them yet.
 */
export const PLATFORMS = [
  'FACEBOOK',
  'INSTAGRAM',
  'LINKEDIN',
  'X',
  'TIKTOK',
  'YOUTUBE',
  'THREADS',
  'PINTEREST',
] as const;
export type Platform = (typeof PLATFORMS)[number];

export const SOCIAL_ACCOUNT_STATUSES = [
  'ACTIVE',
  'NEEDS_RECONNECT',
  'DISABLED',
  'REVOKED',
] as const;
export type SocialAccountStatus = (typeof SOCIAL_ACCOUNT_STATUSES)[number];

/**
 * Post lifecycle (SRS §10), plus PARTIALLY_PUBLISHED.
 *
 * PARTIALLY_PUBLISHED is an addition to the SRS list: with N accounts per post,
 * some targets can succeed while others fail, and neither PUBLISHED nor FAILED
 * tells the truth about "1 of 3 failed" (decision D-006).
 */
export const POST_STATUSES = [
  'IDEA',
  'DRAFT',
  'INTERNAL_REVIEW',
  'CLIENT_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'PARTIALLY_PUBLISHED',
  'FAILED',
  'CANCELED',
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

/** Per-account publish state. NEEDS_REVIEW is where inconclusive reconciliation parks. */
export const VARIANT_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
  'CANCELED',
  'NEEDS_REVIEW',
] as const;
export type VariantStatus = (typeof VARIANT_STATUSES)[number];

export const APPROVAL_STAGES = ['INTERNAL', 'CLIENT'] as const;
export type ApprovalStage = (typeof APPROVAL_STAGES)[number];

export const APPROVAL_STATES = ['PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'CANCELED'] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

/** The SRS §11 production pipeline — a separate axis from post status (D-007). */
export const PRODUCTION_STAGES = [
  'IDEA',
  'COPYWRITING',
  'DESIGN',
  'INTERNAL_REVIEW',
  'CLIENT_REVIEW',
  'SCHEDULING',
] as const;
export type ProductionStage = (typeof PRODUCTION_STAGES)[number];

export const PRODUCTION_TASK_STATES = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE'] as const;
export type ProductionTaskState = (typeof PRODUCTION_TASK_STATES)[number];

export const COMMENT_VISIBILITIES = ['INTERNAL', 'CLIENT_VISIBLE'] as const;
export type CommentVisibility = (typeof COMMENT_VISIBILITIES)[number];

export const MEDIA_KINDS = ['IMAGE', 'VIDEO', 'GIF'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const MEDIA_STATUSES = ['PENDING', 'READY', 'REJECTED'] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export const PUBLISHING_JOB_STATES = [
  'PENDING',
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
  'DEAD_LETTER',
] as const;
export type PublishingJobState = (typeof PUBLISHING_JOB_STATES)[number];

export const PUBLISHING_ATTEMPT_STATES = [
  'IN_FLIGHT',
  'SUCCEEDED',
  'FAILED',
  'RECONCILED',
  'INCONCLUSIVE',
] as const;
export type PublishingAttemptState = (typeof PUBLISHING_ATTEMPT_STATES)[number];

/** Per-metric availability (SRS §18) — a deprecated metric is never stored as 0. */
export const METRIC_AVAILABILITIES = ['AVAILABLE', 'UNSUPPORTED', 'DEPRECATED', 'ERROR'] as const;
export type MetricAvailability = (typeof METRIC_AVAILABILITIES)[number];

export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const ACTOR_TYPES = ['USER', 'SYSTEM', 'WORKER'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const SUBSCRIPTION_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const POST_SOURCES = ['MANUAL', 'AI_IDEA', 'REPURPOSE'] as const;
export type PostSource = (typeof POST_SOURCES)[number];

/**
 * Who wrote an audience comment.
 *
 * `ORBIT` is a reply the agency sent from inside the product. The distinction
 * is what keeps our own replies out of the queue of things needing attention —
 * and it is decided by the adapter, which compares the platform's author id to
 * the connected account's and then discards it.
 */
export const SOCIAL_COMMENT_ORIGINS = ['AUDIENCE', 'ORBIT'] as const;
export type SocialCommentOrigin = (typeof SOCIAL_COMMENT_ORIGINS)[number];

/** Whether somebody at the agency has dealt with a comment yet. */
export const SOCIAL_COMMENT_STATES = ['NEW', 'HANDLED'] as const;
export type SocialCommentState = (typeof SOCIAL_COMMENT_STATES)[number];

/**
 * Whether somebody at the agency has dealt with a private conversation yet.
 *
 * The same two values as a comment, kept as a separate type because the two
 * queues are separate: a conversation reopens when the person writes again,
 * which a comment never does.
 */
export const SOCIAL_CONVERSATION_STATES = ['NEW', 'HANDLED'] as const;
export type SocialConversationState = (typeof SOCIAL_CONVERSATION_STATES)[number];

/**
 * Which way a private message went.
 *
 * `OUTBOUND` covers every message the brand sent, whether from Orbit or from
 * the platform's own app; the author column says which.
 */
export const SOCIAL_MESSAGE_DIRECTIONS = ['INBOUND', 'OUTBOUND'] as const;
export type SocialMessageDirection = (typeof SOCIAL_MESSAGE_DIRECTIONS)[number];

/** What the AI assistant may do for a brand (D-108). */
export const ASSISTANT_MODES = ['OFF', 'SUGGEST', 'AUTO'] as const;

/** A knowledge entry: a question and its answer, or a document (D-108). */
export const KNOWLEDGE_ENTRY_KINDS = ['FAQ', 'DOCUMENT'] as const;
export type KnowledgeEntryKind = (typeof KNOWLEDGE_ENTRY_KINDS)[number];

/** What the assistant did about one message (D-108). */
export const ASSISTANT_ACTIONS = ['SUGGESTED', 'REPLIED', 'ESCALATED'] as const;
export type AssistantAction = (typeof ASSISTANT_ACTIONS)[number];

export const CONTENT_IDEA_STATES = ['SUGGESTED', 'ACCEPTED', 'DISMISSED', 'CONVERTED'] as const;
export type ContentIdeaState = (typeof CONTENT_IDEA_STATES)[number];

/**
 * A generated report's lifecycle (SRS §19).
 *
 * `FAILED` is a real state rather than a deletion: the person who asked is
 * watching a status, and a report that vanished tells them nothing about why.
 */
export const REPORT_STATUSES = ['QUEUED', 'RENDERING', 'READY', 'FAILED'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/**
 * One member on purpose. PDF is in the roadmap and is not implemented; an enum
 * that listed it would let a request be accepted for a format nothing renders.
 */
export const REPORT_FORMATS = ['CSV'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const WORKSPACE_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];
