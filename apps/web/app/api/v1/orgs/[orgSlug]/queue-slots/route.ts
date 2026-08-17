import { z } from 'zod';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { createQueueSlot, listQueueSlots } from '@/features/scheduling/queue-slots';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

const createSlotSchema = z.object({
  workspaceId: z.string().uuid(),
  /** 0 is Sunday, matching `Date.getUTCDay()` and what `earliestSlot` expects. */
  dayOfWeek: z.number().int().min(0).max(6),
  localTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  timezone: z.string().max(64).optional(),
  socialAccountId: z.string().uuid().nullable().optional(),
});

/**
 * Posting slots (SRS §7).
 *
 * Guarded by `post:schedule` — a slot is a standing scheduling decision, and
 * whoever may schedule a post may decide when this client normally posts.
 */
export const GET = withAuth<Params>(
  {
    permission: 'post:read',
    resource: ({ request }) => {
      const workspaceId = new URL(request.url).searchParams.get('workspaceId');
      return workspaceId ? { workspaceId } : {};
    },
    name: 'GET /api/v1/orgs/{orgSlug}/queue-slots',
  },
  async ({ request, ctx }) => {
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) return jsonOk({ slots: [] });

    return jsonOk({ slots: await listQueueSlots(ctx, workspaceId) });
  },
);

export const POST = withAuth<Params>(
  {
    permission: 'post:schedule',
    resource: async ({ request }) => {
      const body = await request
        .clone()
        .json()
        .catch(() => ({}));
      const workspaceId = (body as { workspaceId?: unknown }).workspaceId;
      return typeof workspaceId === 'string' ? { workspaceId } : {};
    },
    name: 'POST /api/v1/orgs/{orgSlug}/queue-slots',
  },
  async ({ request, ctx }) => {
    const input = await readJsonBody(request, createSlotSchema);
    const slot = await createQueueSlot(ctx, input, requestFingerprint(request));

    return jsonOk({ slot }, { status: 201 });
  },
);
