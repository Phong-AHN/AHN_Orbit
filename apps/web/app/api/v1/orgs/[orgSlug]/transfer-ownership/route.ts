import { z } from 'zod';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { transferOwnership } from '@/features/tenancy/members';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

const bodySchema = z.object({ userId: z.string().uuid() });

/**
 * Hand the organization to another member.
 *
 * Its own route rather than a `PATCH /members/{userId}` with `role: 'OWNER'`,
 * because it is its own permission: `org:transfer_ownership` is granted to
 * `OWNER` and withheld from `ADMIN`, while both hold `member:update_role`.
 * Routing it through the member endpoint would let an Admin perform a transfer
 * by another name.
 *
 * The service holds the guards a permission cannot express — the target must be
 * an active, non-client member, and the demotion of the outgoing owner happens
 * in the same transaction as the promotion.
 */
export const POST = withAuth<Params>(
  {
    permission: 'org:transfer_ownership',
    name: 'POST /api/v1/orgs/{orgSlug}/transfer-ownership',
  },
  async ({ request, ctx }) => {
    const { userId } = await readJsonBody(request, bodySchema);
    const result = await transferOwnership(ctx, userId, requestFingerprint(request));
    return jsonOk({ transfer: result });
  },
);
