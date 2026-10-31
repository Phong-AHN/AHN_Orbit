import { z } from 'zod';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import {
  createPinterestSandboxBoard,
  fetchPinterestBoards,
  pinterestAccountScope,
} from '@/features/social/pinterest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; accountId: string };

/**
 * The boards this Pinterest account can pin to.
 *
 * Guarded by `post:create` rather than `social_account:read`, for the same
 * reason as the TikTok creator route: the only caller is the composer, and
 * "where does this pin go?" is a composing decision rather than an
 * account-settings one.
 *
 * The response carries no token and no secret boards — Orbit does not hold the
 * scope that would return them — except in sandbox mode, where the only boards
 * are the secret test boards created below.
 */
export const GET = withAuth<Params>(
  {
    permission: 'post:create',
    // `post:create` is BRAND-scoped. Without this every Content Creator with a
    // grant narrowed to one client is denied (D-069).
    resource: pinterestAccountScope,
    name: 'GET /api/v1/orgs/{orgSlug}/social-accounts/{accountId}/pinterest-boards',
  },
  async ({ ctx, params }) => jsonOk(await fetchPinterestBoards(ctx, params.accountId)),
);

const createSchema = z.object({
  /** Pinterest caps a board name at 50 characters. */
  name: z.string().trim().min(1).max(50),
});

/**
 * Create a secret board — **sandbox mode only**.
 *
 * Production boards are filtered out of Pinterest's sandbox, so a test account
 * has nowhere to pin until one is made. Outside sandbox mode this is refused
 * before Pinterest is called. Same permission and scope as reading the boards:
 * it serves the same composing decision.
 */
export const POST = withAuth<Params>(
  {
    permission: 'post:create',
    resource: pinterestAccountScope,
    name: 'POST /api/v1/orgs/{orgSlug}/social-accounts/{accountId}/pinterest-boards',
  },
  async ({ request, ctx, params }) => {
    const input = await readJsonBody(request, createSchema);
    const board = await createPinterestSandboxBoard(ctx, params.accountId, input.name);
    return jsonOk({ board }, { status: 201 });
  },
);
