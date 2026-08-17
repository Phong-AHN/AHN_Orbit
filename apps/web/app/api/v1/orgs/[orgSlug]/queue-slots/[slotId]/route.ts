import { z } from 'zod';
import { NextResponse } from 'next/server';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { deleteQueueSlot, setQueueSlotActive } from '@/features/scheduling/queue-slots';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; slotId: string };

const patchSchema = z.object({ isActive: z.boolean() });

/**
 * Pause or resume a slot.
 *
 * Deactivating rather than deleting is what a seasonal pause wants: the
 * appointment is remembered and simply not used.
 */
export const PATCH = withAuth<Params>(
  { permission: 'post:schedule', name: 'PATCH /api/v1/orgs/{orgSlug}/queue-slots/{slotId}' },
  async ({ request, ctx, params }) => {
    const { isActive } = await readJsonBody(request, patchSchema);

    return jsonOk({
      slot: await setQueueSlotActive(ctx, params.slotId, isActive, requestFingerprint(request)),
    });
  },
);

/**
 * Remove a slot. Nothing already scheduled moves — a queued post carries its
 * own `scheduledFor` from the moment it was queued.
 */
export const DELETE = withAuth<Params>(
  { permission: 'post:schedule', name: 'DELETE /api/v1/orgs/{orgSlug}/queue-slots/{slotId}' },
  async ({ request, ctx, params }) => {
    await deleteQueueSlot(ctx, params.slotId, requestFingerprint(request));
    return new NextResponse(null, { status: 204 });
  },
);
