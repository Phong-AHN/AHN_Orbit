import {
  ConflictError,
  NotFoundError,
  ValidationError,
  isValidTimeZone,
  type TenantContext,
} from '@orbit/core';
import { withTenant } from '@orbit/db';
import { audit, type AuditInput } from '@/server/audit';

/**
 * Posting slots (SRS §7).
 *
 * A slot is a standing appointment: "this client posts Tuesdays at 09:00".
 * `useNextQueueSlot` has honoured them since T1.12 and there was no way to
 * create one outside a seed script, so in practice the feature did not exist.
 *
 * **A slot is a wall-clock time, not an instant.** 09:00 on a Tuesday means
 * 09:00 to the client, in March and in November alike — which is exactly why
 * the row stores `"HH:MM"` and a zone rather than a UTC offset. The offset
 * changes twice a year; the appointment does not.
 *
 * Slots belong to a **workspace**, and may optionally narrow to one social
 * account: an agency posting to a client's Facebook Page every weekday and to
 * Instagram twice a week needs both shapes, and `socialAccountId = null` is the
 * common one.
 */

const SLOT_SELECT = {
  id: true,
  workspaceId: true,
  socialAccountId: true,
  dayOfWeek: true,
  localTime: true,
  timezone: true,
  isActive: true,
  socialAccount: { select: { id: true, displayName: true, platform: true } },
} as const;

/** `Date.getUTCDay()` order: 0 is Sunday, which is what `earliestSlot` expects. */
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface SlotInput {
  workspaceId: string;
  dayOfWeek: number;
  localTime: string;
  timezone?: string | undefined;
  socialAccountId?: string | null | undefined;
}

export async function listQueueSlots(ctx: TenantContext, workspaceId: string) {
  return withTenant(ctx, (db) =>
    db.queueSlot.findMany({
      where: { workspaceId },
      select: SLOT_SELECT,
      // The order somebody reads a week in, not insertion order.
      orderBy: [{ dayOfWeek: 'asc' }, { localTime: 'asc' }],
    }),
  );
}

export async function createQueueSlot(
  ctx: TenantContext,
  input: SlotInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  if (!Number.isInteger(input.dayOfWeek) || input.dayOfWeek < 0 || input.dayOfWeek > 6) {
    throw new ValidationError('dayOfWeek must be 0–6');
  }

  if (!HHMM.test(input.localTime)) {
    throw new ValidationError('localTime must be HH:MM', {
      userMessage: 'Use a 24-hour time like 09:00.',
    });
  }

  return withTenant(ctx, async (db) => {
    const workspace = await db.workspace.findFirst({
      where: { id: input.workspaceId, deletedAt: null },
      select: { id: true, timezone: true },
    });
    if (!workspace) throw new NotFoundError('Workspace');

    // The client's own zone unless the slot names another — an agency posting
    // into two markets for one client is the case this allows for.
    const timezone = input.timezone || workspace.timezone;
    if (!isValidTimeZone(timezone)) {
      throw new ValidationError(`Unknown IANA timezone: ${timezone}`, {
        userMessage: 'That timezone is not one we recognise.',
      });
    }

    if (input.socialAccountId) {
      const account = await db.socialAccount.findFirst({
        where: { id: input.socialAccountId, workspaceId: input.workspaceId, deletedAt: null },
        select: { id: true },
      });
      // An account belonging to a different client is not a narrowing, it is a
      // mistake. The composite foreign key would refuse it; this says why.
      if (!account) throw new NotFoundError('Social account');
    }

    const duplicate = await db.queueSlot.findFirst({
      where: {
        workspaceId: input.workspaceId,
        dayOfWeek: input.dayOfWeek,
        localTime: input.localTime,
        socialAccountId: input.socialAccountId ?? null,
      },
      select: { id: true },
    });

    // Two identical slots would put two posts at the same minute and read as a
    // scheduling bug rather than a duplicated row.
    if (duplicate) {
      throw new ConflictError('That slot already exists', {
        userMessage: 'There is already a slot at that time.',
      });
    }

    const slot = await db.queueSlot.create({
      data: {
        organizationId: ctx.organizationId,
        workspaceId: input.workspaceId,
        socialAccountId: input.socialAccountId ?? null,
        dayOfWeek: input.dayOfWeek,
        localTime: input.localTime,
        timezone,
      },
      select: SLOT_SELECT,
    });

    await audit(db, ctx, {
      action: 'queue_slot.created',
      resourceType: 'QueueSlot',
      resourceId: slot.id,
      workspaceId: input.workspaceId,
      after: { dayOfWeek: slot.dayOfWeek, localTime: slot.localTime, timezone },
      ...fingerprint,
    });

    return slot;
  });
}

/**
 * Turn a slot on or off.
 *
 * Deactivating rather than deleting is the reversible move, and it is what a
 * seasonal pause wants: the appointment is remembered and simply not used.
 */
export async function setQueueSlotActive(
  ctx: TenantContext,
  slotId: string,
  isActive: boolean,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const existing = await db.queueSlot.findFirst({
      where: { id: slotId },
      select: { id: true, workspaceId: true },
    });
    if (!existing) throw new NotFoundError('Queue slot');

    const slot = await db.queueSlot.update({
      where: { id: slotId },
      data: { isActive },
      select: SLOT_SELECT,
    });

    await audit(db, ctx, {
      action: isActive ? 'queue_slot.enabled' : 'queue_slot.disabled',
      resourceType: 'QueueSlot',
      resourceId: slotId,
      workspaceId: existing.workspaceId,
      ...fingerprint,
    });

    return slot;
  });
}

/**
 * Remove a slot.
 *
 * Nothing already scheduled moves. A post that took this slot has a concrete
 * `scheduledFor` of its own from the moment it was queued — the slot is where
 * that time *came from*, not where it lives — so removing one changes what
 * happens next and never what was already promised to a client.
 */
export async function deleteQueueSlot(
  ctx: TenantContext,
  slotId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const slot = await db.queueSlot.findFirst({
      where: { id: slotId },
      select: { id: true, workspaceId: true, dayOfWeek: true, localTime: true },
    });
    if (!slot) throw new NotFoundError('Queue slot');

    await db.queueSlot.delete({ where: { id: slotId } });

    await audit(db, ctx, {
      action: 'queue_slot.deleted',
      resourceType: 'QueueSlot',
      resourceId: slotId,
      workspaceId: slot.workspaceId,
      before: { dayOfWeek: slot.dayOfWeek, localTime: slot.localTime },
      ...fingerprint,
    });
  });
}
