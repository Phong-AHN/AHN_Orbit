import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ORGANIZATION_ROLES } from '@orbit/core';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { removeMember, updateMemberRole } from '@/features/tenancy/members';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; userId: string };

const patchSchema = z.object({ role: z.enum(ORGANIZATION_ROLES) });

/**
 * Change a member's organization role.
 *
 * The permission gate is `member:update_role`; the service adds the guards a
 * permission cannot express — no self-editing, only owners may touch owners or
 * grant ownership, and the last owner is immovable.
 */
export const PATCH = withAuth<Params>(
  { permission: 'member:update_role', name: 'PATCH /api/v1/orgs/{orgSlug}/members/{userId}' },
  async ({ request, ctx, params }) => {
    const { role } = await readJsonBody(request, patchSchema);
    const result = await updateMemberRole(ctx, params.userId, role, requestFingerprint(request));
    return jsonOk({ membership: result });
  },
);

export const DELETE = withAuth<Params>(
  { permission: 'member:remove', name: 'DELETE /api/v1/orgs/{orgSlug}/members/{userId}' },
  async ({ request, ctx, params }) => {
    await removeMember(ctx, params.userId, requestFingerprint(request));
    return new NextResponse(null, { status: 204 });
  },
);
