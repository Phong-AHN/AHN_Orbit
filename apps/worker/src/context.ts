import type { Permission } from '@orbit/rbac';
import { systemContext } from '@orbit/auth';
import { platformDb, type TenantDb } from '@orbit/db';
import { resolveJobTenant, type QueueName } from '@orbit/queue';
import type { TenantContext } from '@orbit/core';

/**
 * Turning a job into a tenant context (SRS §4, docs/RBAC.md §6).
 *
 * The pattern every processor follows, and the reason it is a helper rather
 * than a convention:
 *
 *   1. look the subject row up **by primary key on the platform client** —
 *      the only unscoped read a processor makes, and it selects nothing but
 *      the identifiers needed to establish the tenant;
 *   2. derive the tenant from that row, comparing it against what the payload
 *      claimed (`resolveJobTenant` raises a tenant-isolation security event on
 *      a mismatch);
 *   3. build a `SYSTEM` principal with a **minimal capability list** — a
 *      publish worker holds `post:read`, `social_account:read`, `media:read`
 *      and nothing else, so a payload cannot talk it into deleting a brand;
 *   4. hand the processor a scoped client bound to the derived tenant.
 *
 * Step 1 is why the lookup is deliberately narrow. A processor that needs the
 * subject's *content* re-reads it through the scoped client in step 4, where
 * both the tenant filter and RLS apply.
 */

export interface JobTenant {
  organizationId: string;
  ctx: TenantContext;
}

export interface SubjectLookup {
  /** Model to resolve on. Its row carries the authoritative tenant. */
  subjectType: 'postVariant' | 'mediaAsset' | 'socialAccount' | 'post';
  subjectId: string;
}

/**
 * Resolve the tenant a job actually belongs to.
 *
 * Note the unscoped read: it is safe precisely because it selects only
 * `organizationId`, by primary key, and its result is used to *build* the
 * scope rather than to bypass one. There is no other way to bootstrap a tenant
 * context from a background job.
 */
export async function resolveTenantForJob(input: {
  queue: QueueName;
  jobId: string;
  claimedOrganizationId: string;
  subject: SubjectLookup;
  actorName: string;
  capabilities: readonly Permission[];
  correlationId: string;
}): Promise<JobTenant> {
  const subject = await lookupSubject(input.subject);

  const organizationId = resolveJobTenant(input.claimedOrganizationId, subject, {
    queue: input.queue,
    jobId: input.jobId,
    subjectType: input.subject.subjectType,
    subjectId: input.subject.subjectId,
  });

  return {
    organizationId,
    ctx: systemContext({
      organizationId,
      actorName: input.actorName,
      capabilities: input.capabilities,
      correlationId: input.correlationId,
    }),
  };
}

async function lookupSubject(subject: SubjectLookup): Promise<{ organizationId: string } | null> {
  const select = { organizationId: true } as const;
  const where = { id: subject.subjectId };

  switch (subject.subjectType) {
    case 'postVariant':
      return platformDb.postVariant.findUnique({ where, select });
    case 'mediaAsset':
      return platformDb.mediaAsset.findUnique({ where, select });
    case 'socialAccount':
      return platformDb.socialAccount.findUnique({ where, select });
    case 'post':
      return platformDb.post.findUnique({ where, select });
    default: {
      const exhaustive: never = subject.subjectType;
      throw new Error(`Unhandled job subject type: ${String(exhaustive)}`);
    }
  }
}

export type { TenantDb };
