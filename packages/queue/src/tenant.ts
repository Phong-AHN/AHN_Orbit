import { TenantIsolationError } from '@orbit/core';
import { logger } from '@orbit/observability';

/**
 * Deriving a job's tenant (SRS §4).
 *
 * A job payload names the work — a `postVariantId`, a `mediaAssetId` — and it
 * also carries an `organizationId`. That second field is written by our own
 * producers, but a queue is durable shared state: a job enqueued before a
 * migration, a hand-inserted entry, or a producer bug could all put the wrong
 * value there. Trusting it would mean a job could name any tenant it liked and
 * be handed a scoped client for it.
 *
 * So the tenant is **derived from the subject row**, which the processor looks
 * up by primary key, and the payload's value is only ever *compared*. A
 * mismatch is a tenant-isolation security event and the job fails — it is never
 * reconciled in favour of either side, because both readings cannot be right
 * and guessing which is the actual hazard.
 *
 * This is the queue-side equivalent of `withAuth` taking the organization from
 * the URL and cross-checking it against membership, rather than reading it from
 * a request body.
 */

export interface TenantSubject {
  /** The row the job is about. Its `organizationId` is the authority. */
  organizationId: string;
}

/**
 * Confirm the payload's claimed tenant matches the subject row's, and return
 * the row's.
 *
 * @param claimed  what the payload said
 * @param subject  the row the processor resolved by primary key
 */
export function resolveJobTenant(
  claimed: string,
  subject: TenantSubject | null,
  context: { queue: string; jobId: string; subjectType: string; subjectId: string },
): string {
  if (!subject) {
    // Nothing to derive from. Refusing is the only safe answer — falling back
    // to the claimed value is precisely the trust this function exists to deny.
    throw new TenantIsolationError('Job subject does not exist', {
      context: { ...context, reason: 'subject not found' },
    });
  }

  if (subject.organizationId !== claimed) {
    logger.error('job payload named a different tenant than its subject', {
      securityEvent: true,
      ...context,
      claimedOrganizationId: claimed,
      actualOrganizationId: subject.organizationId,
    });

    throw new TenantIsolationError('Job payload tenant does not match its subject', {
      context: { ...context, reason: 'payload tenant mismatch' },
    });
  }

  return subject.organizationId;
}
