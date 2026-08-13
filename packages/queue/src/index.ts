/**
 * @orbit/queue — Redis + BullMQ infrastructure (docs/ARCHITECTURE.md §5).
 *
 * Split deliberately into a producer half and a consumer half. `apps/web`
 * imports only the producer surface — `enqueue`, `cancelJob`, `queueDepths` and
 * the payload types. The consumer half (`startWorker`) refuses to run outside
 * the worker process, so the separation is enforced rather than documented.
 */

export {
  QUEUE_DEFINITIONS,
  QUEUE_NAMES,
  isQueueName,
  isTenantScopedQueue,
  jobEnvelopeSchema,
  parsePayload,
  publishPayloadSchema,
  mediaPayloadSchema,
  analyticsPayloadSchema,
  accountHealthPayloadSchema,
  notificationPayloadSchema,
  maintenancePayloadSchema,
  schedulerPayloadSchema,
  type JobEnvelope,
  type PayloadOf,
  type QueueName,
} from './queues.js';

export { redis, blockingConnection, closeSharedConnection, isWorkerProcess } from './connection.js';

export {
  BACKOFF_SCHEDULE_MS,
  MAX_ATTEMPTS,
  backoffFor,
  decideRetry,
  describeFailure,
  errorCodeOf,
  isRetryable,
  type RetryDecision,
  type RetryRefusal,
} from './retry.js';

export { resolveJobTenant, type TenantSubject } from './tenant.js';

export {
  LOCK_UNAVAILABLE,
  acquireLock,
  publishLockKey,
  releaseLock,
  withLock,
  type Lock,
} from './lock.js';

export {
  applyProviderUsage,
  bucketState,
  healthRateLimitKey,
  rateLimitKey,
  takeToken,
  type BucketConfig,
  type RateLimitResult,
} from './rate-limit.js';

export {
  cancelJob,
  closeQueues,
  enqueue,
  queueDepths,
  queueFor,
  type EnqueueOptions,
  type QueueDepth,
} from './producer.js';

export {
  causeChain,
  deadLetterCount,
  discardDeadLetter,
  getDeadLetter,
  listDeadLetters,
  recordDeadLetter,
  type DeadLetterEntry,
} from './dead-letter.js';

export {
  assertWorkerProcess,
  runAttempt,
  startWorker,
  type JobContext,
  type Processor,
  type RunningWorker,
  type WorkerOptions,
} from './worker.js';

export {
  installShutdownHandlers,
  isShuttingDown,
  resetShutdownState,
  shutdown,
  type ShutdownOptions,
} from './shutdown.js';
