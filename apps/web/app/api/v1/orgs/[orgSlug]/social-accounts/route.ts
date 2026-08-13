import { z } from 'zod';
import { PLATFORMS } from '@orbit/core';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { ensureProvidersRegistered } from '@/server/providers';
import { connectAccounts, listAccounts } from '@/features/social/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

const connectSchema = z.object({
  platform: z.enum(PLATFORMS),
  workspaceId: z.string().uuid(),
  brandId: z.string().uuid(),
  /** Staged account ids, from the picker. */
  socialAccountIds: z.array(z.string().uuid()).min(1).max(50),
});

export const GET = withAuth<Params>(
  { permission: 'social_account:read', name: 'GET /api/v1/orgs/{orgSlug}/social-accounts' },
  async ({ request, ctx }) => {
    const url = new URL(request.url);
    const workspaceId = url.searchParams.get('workspaceId') ?? undefined;
    const brandId = url.searchParams.get('brandId') ?? undefined;

    return jsonOk({
      accounts: await listAccounts(ctx, {
        ...(workspaceId ? { workspaceId } : {}),
        ...(brandId ? { brandId } : {}),
      }),
    });
  },
);

/**
 * Confirm which discovered accounts to connect.
 *
 * The second half of the OAuth flow: the callback staged everything the
 * authorization surfaced, and this activates the subset the user chose while
 * discarding the rest along with their credentials.
 */
export const POST = withAuth<Params>(
  {
    permission: 'social_account:connect',
    resource: async ({ request }) => {
      const body = await request
        .clone()
        .json()
        .catch(() => ({}));
      const parsed = connectSchema.partial().safeParse(body);
      return parsed.success && parsed.data.workspaceId
        ? { workspaceId: parsed.data.workspaceId }
        : {};
    },
    name: 'POST /api/v1/orgs/{orgSlug}/social-accounts',
  },
  async ({ request, ctx }) => {
    ensureProvidersRegistered();
    const input = await readJsonBody(request, connectSchema);

    const connected = await connectAccounts(ctx, input, requestFingerprint(request));
    return jsonOk({ connected }, { status: 201 });
  },
);
