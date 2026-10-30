import { z } from 'zod';
import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { revokeGrant } from '@/features/agent/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; grantId: string };

/**
 * Revoke an AI app's access (D-109 §6). Takes effect on its next call: every
 * MCP request re-reads the grant. One's own, or anyone's for an Owner or Admin.
 */
export const DELETE = withAuth<Params>(
  { name: 'DELETE /api/v1/orgs/{orgSlug}/agent-grants/{grantId}' },
  async ({ ctx, params }) => {
    await revokeGrant(ctx, z.string().uuid().parse(params.grantId));
    return jsonOk({ revoked: true });
  },
);
