import { NotFoundError, ValidationError } from '@orbit/core';
import { platformDb } from '@orbit/db';
import {
  QUEUE_NAMES,
  deadLetterCount,
  discardDeadLetter,
  enqueue,
  getDeadLetter,
  isQueueName,
  listDeadLetters,
  parsePayload,
  queueDepths,
  type DeadLetterEntry,
  type QueueName,
} from '@orbit/queue';

/**
 * Operating the platform (SRS §28, T1.18).
 *
 * Every read here is **unscoped by necessity** — a platform admin's job is to
 * look across tenants — and every read is therefore written as an explicit
 * allowlist of columns. docs/RBAC.md §2 puts it plainly: AHN staff "see system
 * state, never client content or secrets", and §1 rule 4 makes platform admins
 * emphatically not tenant superusers.
 *
 * So the shape of this file is: counts, statuses, identifiers and timestamps.
 * There is no query here that can return a post body, a caption, a comment, a
 * media asset, a brand voice, or anything from `SocialCredential`. Not because
 * a filter removes them — because nothing asks for them.
 *
 * The one thing an admin can *change* is retrying a dead-lettered job, and that
 * goes through `platformAudit` with a mandatory reason.
 */

/** Bound on any admin listing. Pagination beyond this is a later problem. */
const MAX_ROWS = 100;

// ── Organizations ───────────────────────────────────────────────────────────

/**
 * Tenants, as operational records.
 *
 * **Deliberately absent:** `settings` (agency configuration), `logoUrl`, and
 * every relation that would reach content. What is here is what a support
 * engineer needs to answer "who is this, how big are they, and are they
 * paying?" — docs/RBAC.md §3 note 1: "Org name, plan, counts, health — not
 * content."
 *
 * Counts come from `_count`, which Prisma resolves as correlated subqueries in
 * one statement rather than a query per organization.
 */
export async function listOrganizations(search?: string) {
  const term = search?.trim();

  return platformDb.organization.findMany({
    where: {
      deletedAt: null,
      ...(term
        ? {
            OR: [
              { name: { contains: term, mode: 'insensitive' as const } },
              { slug: { contains: term, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
      subscription: {
        select: { plan: true, status: true, seats: true, currentPeriodEnd: true },
      },
      _count: {
        select: { memberships: true, workspaces: true, socialAccounts: true, posts: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_ROWS,
  });
}

// ── Users ───────────────────────────────────────────────────────────────────

/**
 * People, for support lookups.
 *
 * Email is included because it is how a support request identifies its subject
 * — someone writes in from an address and this is what turns that into an
 * account. `firebaseUid` is not: it is an authentication identifier, and having
 * it on a screen serves no support purpose while making it available to
 * shoulder-surf.
 *
 * Membership *roles* are shown without workspace detail: which organizations
 * someone belongs to is operational, which brands they touch is not.
 */
export async function listUsers(search?: string) {
  const term = search?.trim();

  return platformDb.user.findMany({
    where: {
      deletedAt: null,
      ...(term
        ? {
            OR: [
              { email: { contains: term, mode: 'insensitive' as const } },
              { name: { contains: term, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      email: true,
      name: true,
      isPlatformAdmin: true,
      lastSeenAt: true,
      createdAt: true,
      organizationMemberships: {
        select: {
          role: true,
          status: true,
          organization: { select: { id: true, name: true, slug: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_ROWS,
  });
}

// ── Social accounts ─────────────────────────────────────────────────────────

/**
 * Connection health across every tenant.
 *
 * **This is the narrowest projection in the file, and deliberately the
 * narrowest read anywhere in the product.** docs/RBAC.md §3 note 2 allows a
 * platform admin "connected / needs-reconnect / revoked" and nothing else, so
 * that is literally what this returns.
 *
 * Absent, and each for its own reason:
 *  - `displayName` and `handle` — *which* Pages a client manages is the client's
 *    commercial information, not platform state. The agency knows which account
 *    an id refers to; we do not need to.
 *  - `externalId` — the Page's own id at Meta, same argument.
 *  - `healthError` — a provider message about a specific client's connection.
 *  - anything from `SocialCredential` — no query in this file touches that
 *    table at all, and `social_credential:read_plaintext` is held by nobody
 *    (docs/RBAC.md §4.3).
 *
 * What an admin gets is "organization X has an account that has been broken
 * since Tuesday", which is what an operational alert needs and no more.
 */
export async function listSocialAccountHealth(status?: string) {
  return platformDb.socialAccount.findMany({
    where: {
      deletedAt: null,
      ...(status && status !== 'ALL' ? { status: status as 'ACTIVE' } : {}),
    },
    select: {
      id: true,
      platform: true,
      status: true,
      healthCheckedAt: true,
      organization: { select: { id: true, name: true, slug: true } },
    },
    orderBy: [{ status: 'asc' }, { healthCheckedAt: 'asc' }],
    take: MAX_ROWS,
  });
}

// ── Health ──────────────────────────────────────────────────────────────────

export interface PlatformHealth {
  database: { reachable: boolean };
  queues: Awaited<ReturnType<typeof queueDepths>>;
  deadLetters: number;
  /** Tenant-agnostic totals, for a sense of scale rather than of any customer. */
  totals: { organizations: number; users: number; socialAccounts: number };
}

/**
 * Is the platform working?
 *
 * Aggregate only, per docs/RBAC.md §3 note 3: "Job counts, error rates, API
 * health — not client performance data." A count of organizations is scale; a
 * count of one organization's posts would be a customer metric.
 */
export async function platformHealth(): Promise<PlatformHealth> {
  const [reachable, queues, deadLetters, organizations, users, socialAccounts] = await Promise.all([
    platformDb.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
    queueDepths(),
    deadLetterCount(),
    platformDb.organization.count({ where: { deletedAt: null } }),
    platformDb.user.count({ where: { deletedAt: null } }),
    platformDb.socialAccount.count({ where: { deletedAt: null } }),
  ]);

  return {
    database: { reachable },
    queues,
    deadLetters,
    totals: { organizations, users, socialAccounts },
  };
}

// ── Dead letters ────────────────────────────────────────────────────────────

export async function listJobs(limit = 50): Promise<DeadLetterEntry[]> {
  return listDeadLetters(Math.min(limit, MAX_ROWS));
}

export async function getJob(id: string): Promise<DeadLetterEntry> {
  const entry = await getDeadLetter(id);
  if (!entry) throw new NotFoundError('Dead-lettered job');
  return entry;
}

/**
 * Queues an admin may re-enqueue into.
 *
 * **`publish` is deliberately absent** (decision D-045). Publishing has exactly
 * one door — the scheduler and the engine's four idempotency layers — and
 * decisions **D-028** and **D-029** are both about refusing to add a second
 * one. A stuck publish already has a tenant-side route out: the publishing log's
 * per-job retry (T1.14) and the parked-variant resolution flow (**D-029**), both
 * of which run inside the tenant, with its permissions, through the same engine.
 *
 * An admin who re-enqueued a publish here would be doing it without the post's
 * current content, without the tenant's approval state, and without any of that
 * being visible to the agency. Refusing is the smaller cost.
 */
const RETRYABLE_QUEUES: readonly QueueName[] = QUEUE_NAMES.filter((name) => name !== 'publish');

export function isRetryableQueue(queue: string): boolean {
  return isQueueName(queue) && RETRYABLE_QUEUES.includes(queue);
}

export interface RetryOutcome {
  id: string;
  queue: QueueName;
  organizationId: string | null;
}

/**
 * Re-enqueue a dead-lettered job.
 *
 * The payload is **re-parsed before it is trusted**, even though we wrote it
 * ourselves: it has been sitting in Redis, and a payload that no longer matches
 * its schema — because the schema moved on — must fail here rather than inside
 * a processor. That is the same rule the worker applies on the way in
 * (docs/ARCHITECTURE.md §5.1: parsed on both sides).
 *
 * The entry is discarded on success, so the dead-letter set stays a list of
 * things still wrong rather than a history of things once wrong.
 */
export async function retryJob(id: string): Promise<RetryOutcome> {
  const entry = await getJob(id);

  if (!isRetryableQueue(entry.queue)) {
    throw new ValidationError(`Jobs on the ${entry.queue} queue are not retried from here`, {
      userMessage:
        'Publishing is retried from the organization’s own publishing log, so it goes through the same checks as any other publish.',
      context: { queue: entry.queue, deadLetterId: id },
    });
  }

  if (entry.payload === undefined) {
    throw new ValidationError('This job has no payload to retry', {
      userMessage:
        'This job failed before its payload could be read, so there is nothing valid to run again.',
      context: { deadLetterId: id },
    });
  }

  // Throws if the stored payload no longer satisfies its schema.
  const payload = parsePayload(entry.queue, entry.payload);

  await enqueue(entry.queue, payload);
  await discardDeadLetter(id);

  return { id, queue: entry.queue, organizationId: entry.organizationId };
}

/** Drop a dead letter that has been dealt with elsewhere. */
export async function discardJob(id: string): Promise<RetryOutcome> {
  const entry = await getJob(id);
  await discardDeadLetter(id);
  return { id, queue: entry.queue, organizationId: entry.organizationId };
}
