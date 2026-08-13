import {
  ConflictError,
  NotFoundError,
  ValidationError,
  actorUserId,
  clock,
  isUserPrincipal,
  type TenantContext,
} from '@orbit/core';
import { withTenant } from '@orbit/db';
import { logger } from '@orbit/observability';
import { audit, type AuditInput } from '@/server/audit';

/**
 * Resolving a parked publish (SRS §13, §14; decision D-029).
 *
 * T1.13 parks a variant in `NEEDS_REVIEW` when it could not establish whether a
 * post went out — an ambiguous timeout the provider could not answer. Nothing
 * automated touches it again, deliberately: guessing is how a client's Page
 * gets the same post twice.
 *
 * That leaves a human as the only way out, and until now there was no door.
 * This is the door. Two answers, and they are not symmetric:
 *
 *   • **"It did publish"** — the person checked the Page and saw it. We record
 *     that, with the external id if they have it. No provider call, because the
 *     provider is precisely what could not tell us.
 *   • **"It did not publish"** — back to `SCHEDULED`, re-enqueued through the
 *     *existing* engine, which applies all four idempotency layers again.
 *
 * Both require a reason, because both are a human overriding a machine that
 * said "I don't know", and six months later someone will need to know why. Both
 * are audited as security events for the same reason `onBehalfOf` is in the
 * approval flow.
 *
 * No publishing logic lives here and no second state machine is introduced:
 * the retry path hands straight back to T1.13's engine.
 *
 * ## Why the post's own status is not recomputed here
 *
 * A post whose accounts had mixed outcomes already settled to
 * `PARTIALLY_PUBLISHED`, and the transition table has no
 * `PARTIALLY_PUBLISHED → PUBLISHED`. That is not an oversight to work around:
 * the post's status records *what happened during publishing*, and "some
 * accounts worked, one had to be sorted out by hand" is exactly that. The
 * variant carries the corrected truth, which is the level at which it is true.
 * A `NOT_PUBLISHED` resolution does re-settle the post, because it goes back
 * through the engine, which owns that rollup.
 */

export type ParkedResolution = 'PUBLISHED' | 'NOT_PUBLISHED' | 'ABANDON';

export interface ResolveParkedInput {
  resolution: ParkedResolution;
  /** Required. Recorded on the audit row and shown in the attempt history. */
  reason: string;
  /** For `PUBLISHED`: the id the person found on the platform, if they have it. */
  externalPostId?: string | undefined;
  externalPermalink?: string | undefined;
}

export async function resolveParkedVariant(
  ctx: TenantContext,
  variantId: string,
  input: ResolveParkedInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  if (!input.reason.trim()) {
    throw new ValidationError('A reason is required to resolve a parked publish', {
      userMessage: 'Say how you established what happened — it goes in the audit trail.',
      details: [{ field: 'reason', issue: 'required' }],
    });
  }

  // Confirming a publish means naming the post. A DB check constraint requires
  // it too (`PostVariant_published_requires_external_id`), and rightly: a
  // variant marked published with nothing to point at is an unverifiable claim,
  // and it would break reconciliation and analytics downstream.
  if (input.resolution === 'PUBLISHED' && !input.externalPostId?.trim()) {
    throw new ValidationError('Confirming a publish requires the post id', {
      userMessage:
        "Paste the post's id or link from the platform. Without it there is no way to check this later.",
      details: [{ field: 'externalPostId', issue: 'required when confirming it published' }],
    });
  }

  const resolved = await withTenant(ctx, async (db) => {
    const variant = await db.postVariant.findFirst({
      where: { id: variantId, deletedAt: null },
      select: {
        id: true,
        status: true,
        postId: true,
        scheduledFor: true,
        externalPostId: true,
        socialAccount: { select: { id: true, displayName: true } },
        post: { select: { workspaceId: true, brandId: true } },
      },
    });
    if (!variant) throw new NotFoundError('Post variant');

    // Only a parked variant can be resolved. Anything else either has a real
    // outcome already or is still in the engine's hands.
    if (variant.status !== 'NEEDS_REVIEW') {
      throw new ConflictError('This publish is not waiting for a decision', {
        userMessage: 'This account is not waiting on a decision — its outcome is already known.',
        context: { status: variant.status },
      });
    }

    const now = clock.now();

    switch (input.resolution) {
      case 'PUBLISHED': {
        await db.postVariant.update({
          where: { id: variantId },
          data: {
            status: 'PUBLISHED',
            // Keep whatever the engine may already have found; only fill gaps.
            ...(input.externalPostId ? { externalPostId: input.externalPostId } : {}),
            ...(input.externalPermalink ? { externalPermalink: input.externalPermalink } : {}),
            publishedAt: now,
            lastError: {
              code: 'RESOLVED_BY_HUMAN',
              message: `Confirmed published by a person: ${input.reason}`,
            },
          },
        });
        break;
      }

      case 'NOT_PUBLISHED': {
        // Back into the engine's hands. `scheduledFor` moves to now, which
        // yields a *new* idempotency key — correct, because this is a new
        // publish attempt and must not collapse onto the ambiguous one.
        await db.postVariant.update({
          where: { id: variantId },
          data: {
            status: 'SCHEDULED',
            scheduledFor: now,
            externalPostId: null,
            externalPermalink: null,
            lastError: {
              code: 'RETRY_AFTER_REVIEW',
              message: `A person confirmed it had not published: ${input.reason}`,
            },
          },
        });
        break;
      }

      case 'ABANDON': {
        await db.postVariant.update({
          where: { id: variantId },
          data: {
            status: 'FAILED',
            lastError: {
              code: 'ABANDONED_BY_HUMAN',
              message: `Given up on by a person: ${input.reason}`,
            },
          },
        });
        break;
      }

      default: {
        const exhaustive: never = input.resolution;
        throw new Error(`Unhandled resolution: ${String(exhaustive)}`);
      }
    }

    await audit(db, ctx, {
      action: 'post_variant.publish_resolved',
      resourceType: 'PostVariant',
      resourceId: variantId,
      workspaceId: variant.post.workspaceId,
      brandId: variant.post.brandId,
      before: { status: 'NEEDS_REVIEW', externalPostId: variant.externalPostId },
      after: {
        resolution: input.resolution,
        externalPostId: input.externalPostId ?? variant.externalPostId,
      },
      reason: input.reason,
      ...fingerprint,
    });

    return variant;
  });

  // A person overriding "we don't know" is exactly the kind of act that needs
  // to be findable later, so it is a security event rather than an info line.
  logger.warn('a parked publish was resolved by a person', {
    securityEvent: true,
    variantId,
    postId: resolved.postId,
    organizationId: ctx.organizationId,
    resolution: input.resolution,
    actor: isUserPrincipal(ctx.principal) ? actorUserId(ctx) : 'system',
  });

  return { variantId, postId: resolved.postId, resolution: input.resolution };
}
