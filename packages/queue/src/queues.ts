import { z } from 'zod';

/**
 * The queue catalogue (docs/ARCHITECTURE.md §5.1).
 *
 * Every queue is declared here with its payload schema and its concurrency.
 * A producer cannot enqueue to a queue that is not in this table, and a payload
 * that does not parse never reaches a processor — which is what stops a
 * malformed or hand-crafted job from being handed to provider code.
 *
 * ## Why tenant data in the payload is not trusted
 *
 * A payload has to carry *something* to identify the work, and that includes an
 * `organizationId`. It is written by our own producers, but a queue is durable
 * shared state: a stale job from before a migration, a hand-inserted job, or a
 * producer bug could all put the wrong value there.
 *
 * So the rule is: the payload's `organizationId` is a **checked assertion, not
 * a source of truth**. Every processor resolves its subject row from the
 * database first and derives the tenant from *that* row; the payload's value is
 * compared, and a mismatch is a tenant-isolation security event, not a warning.
 * `resolveJobTenant` in `tenant.ts` is the only sanctioned way to do it.
 */

/** Every field a job needs regardless of what it does. */
export const jobEnvelopeSchema = z.object({
  /**
   * Asserted, never trusted. The processor derives the real tenant from the
   * subject row and compares — see `resolveJobTenant`.
   */
  organizationId: z.string().uuid(),
  /**
   * Threaded from the request that caused the job, so a user action and the
   * background work it triggered share one id across every log line.
   */
  correlationId: z.string().min(1).max(200),
});

export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;

// ── Payloads ────────────────────────────────────────────────────────────────

/**
 * Publish one `PostVariant` (T1.13).
 *
 * Deliberately just identifiers. Resolving the content at publish time rather
 * than embedding it means a job queued before an edit cannot publish the stale
 * copy — and it keeps post bodies out of Redis.
 */
export const publishPayloadSchema = jobEnvelopeSchema.extend({
  postVariantId: z.string().uuid(),
  /**
   * Layer 1 of idempotency: derived from variant + schedule + content hash, and
   * reused as the BullMQ job id so a duplicate add is silently dropped.
   */
  idempotencyKey: z.string().min(1).max(200),
  publishingJobId: z.string().uuid(),
});

export const mediaPayloadSchema = jobEnvelopeSchema.extend({
  mediaAssetId: z.string().uuid(),
});

export const analyticsPayloadSchema = jobEnvelopeSchema.extend({
  socialAccountId: z.string().uuid(),
  postVariantId: z.string().uuid().optional(),
});

/**
 * Pulling audience comments back for one published post, or for an account.
 *
 * Its own queue rather than a second shape on `analytics`, which it otherwise
 * resembles. Two reasons: the provider quota it spends is a different one, and
 * a comment backlog on a viral post must not be able to starve the metrics
 * ingestion that the whole analytics screen depends on.
 */
export const engagementPayloadSchema = jobEnvelopeSchema.extend({
  socialAccountId: z.string().uuid(),
  /** Absent means every recently published variant on that account. */
  postVariantId: z.string().uuid().optional(),
  /** Provider cursor, when continuing a thread too long for one job. */
  cursor: z.string().max(500).optional(),
});

export const accountHealthPayloadSchema = jobEnvelopeSchema.extend({
  socialAccountId: z.string().uuid(),
});

export const notificationPayloadSchema = jobEnvelopeSchema.extend({
  event: z.string().min(1).max(100),
  /** Recipients are resolved by the processor, never listed by the producer. */
  resourceType: z.enum(['Post', 'PostVariant', 'SocialAccount']),
  resourceId: z.string().uuid(),
  /**
   * Who caused the event, so they are not told about their own action.
   *
   * Used **only to remove a recipient**, never to add one and never for an
   * authorization decision — so a wrong or forged value can at worst cost
   * someone a notification they would have ignored. That asymmetry is what
   * makes it safe to carry a user id in a payload at all (contrast
   * `organizationId`, which is a checked assertion — decision D-021).
   */
  actorUserId: z.string().uuid().optional(),
});

/**
 * Housekeeping. Runs against the whole platform rather than one tenant, so it
 * carries the nil uuid and is the one job type `resolveJobTenant` refuses —
 * maintenance uses the platform client directly and is audited as such.
 */
export const maintenancePayloadSchema = z.object({
  correlationId: z.string().min(1).max(200),
  task: z.enum([
    'drain-email-outbox',
    'retention',
    'analytics-rollup',
    'cleanup-staged-accounts',
    'reconcile-stuck-jobs',
    'sweep-account-health',
    'sweep-comments',
    // D-107: stored webhook events nobody processed, and the conversation backfill.
    'sweep-webhook-events',
    'sweep-conversations',
  ]),
});

/**
 * One stored webhook event, to be turned into rows (**D-107**).
 *
 * Platform-wide, like maintenance, and for a reason of its own: a delivery
 * names an account by the platform's id, and which organizations have that
 * account connected is something the processor finds out — not something the
 * route could assert. So there is no `organizationId` to check here. The
 * processor resolves each matching account and derives the tenant from *that*
 * row, which is D-021 applied one step later rather than skipped.
 *
 * The payload is an id and nothing else. The message itself waits in the
 * database, which keeps private messages out of Redis.
 */
export const webhooksPayloadSchema = z.object({
  correlationId: z.string().min(1).max(200),
  webhookEventId: z.string().uuid(),
});

/**
 * Reading one account's private conversations: the backfill behind the
 * webhooks, and the first import when an account is connected (**D-107**).
 */
export const messagingPayloadSchema = jobEnvelopeSchema.extend({
  socialAccountId: z.string().uuid(),
  /** Provider cursor, when one account has more conversations than one job reads. */
  cursor: z.string().max(500).optional(),
});

/**
 * The 30-second scheduler sweep (docs/ARCHITECTURE.md §5.1, assumption C10).
 *
 * Platform-wide like maintenance, and on its own queue rather than sharing the
 * housekeeping one: `maintenance` runs at concurrency 1, so a slow retention
 * pass would delay the sweep, and a late sweep means posts publish late.
 */
export const schedulerPayloadSchema = z.object({
  correlationId: z.string().min(1).max(200),
  task: z.enum(['sweep-due', 'report-stale']),
});

/**
 * Rendering a client report (SRS §19, T3.5).
 *
 * The payload names the row and nothing else. What the report *contains* — its
 * range, its filters — lives in `Report.parameters`, written when the request
 * was authorised, so a job cannot widen its own scope by carrying different
 * arguments than the ones that were approved.
 */
export const reportPayloadSchema = jobEnvelopeSchema.extend({
  reportId: z.string().uuid(),
});

// ── The catalogue ───────────────────────────────────────────────────────────

export const QUEUE_DEFINITIONS = {
  publish: { schema: publishPayloadSchema, concurrency: 8 },
  media: { schema: mediaPayloadSchema, concurrency: 5 },
  analytics: { schema: analyticsPayloadSchema, concurrency: 3 },
  engagement: { schema: engagementPayloadSchema, concurrency: 3 },
  // Low: a render reads a lot of rows and nobody is blocked on the second one.
  reports: { schema: reportPayloadSchema, concurrency: 2 },
  'account-health': { schema: accountHealthPayloadSchema, concurrency: 2 },
  notifications: { schema: notificationPayloadSchema, concurrency: 10 },
  maintenance: { schema: maintenancePayloadSchema, concurrency: 1 },
  scheduler: { schema: schedulerPayloadSchema, concurrency: 1 },
  // A message is somebody waiting; webhook events are small and many.
  webhooks: { schema: webhooksPayloadSchema, concurrency: 5 },
  // Low: the backfill reads a lot per job and nobody is blocked on it.
  messaging: { schema: messagingPayloadSchema, concurrency: 2 },
} as const;

export type QueueName = keyof typeof QUEUE_DEFINITIONS;

export const QUEUE_NAMES = Object.keys(QUEUE_DEFINITIONS) as QueueName[];

export type PayloadOf<Q extends QueueName> = z.infer<(typeof QUEUE_DEFINITIONS)[Q]['schema']>;

export function isQueueName(value: string): value is QueueName {
  return Object.hasOwn(QUEUE_DEFINITIONS, value);
}

/**
 * Parse a payload, or throw.
 *
 * Called on both sides — the producer catches its own bug immediately, and the
 * consumer refuses anything that reached the queue by another route.
 */
export function parsePayload<Q extends QueueName>(queue: Q, raw: unknown): PayloadOf<Q> {
  return QUEUE_DEFINITIONS[queue].schema.parse(raw) as PayloadOf<Q>;
}

/**
 * Queues whose work is per-tenant.
 *
 * `maintenance` and `scheduler` are the deliberate exceptions: both sweep the
 * whole platform, use the platform client directly, and carry no tenant to
 * assert. Everything they *enqueue* is tenant-scoped in the normal way.
 *
 * `webhooks` is the third (D-107): a delivery names a platform account, which
 * any number of organizations may have connected, so the tenant is found by the
 * processor per matching account rather than asserted by whoever enqueued it.
 */
export function isTenantScopedQueue(queue: QueueName): boolean {
  return queue !== 'maintenance' && queue !== 'scheduler' && queue !== 'webhooks';
}
