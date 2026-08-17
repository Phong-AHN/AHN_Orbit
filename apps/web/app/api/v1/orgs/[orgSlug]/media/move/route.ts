import { z } from 'zod';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { moveAssets } from '@/features/media/folders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

const moveSchema = z.object({
  assetIds: z.array(z.string().uuid()).min(1).max(200),
  /** `null` moves them out to the workspace root. */
  folderId: z.string().uuid().nullable(),
});

/**
 * File assets into a folder (SRS §12).
 *
 * Every asset is checked against the destination's workspace by the service, so
 * one client's photograph cannot land in another client's campaign folder — the
 * count returned is how many actually moved, which will be fewer than asked for
 * if something was out of scope.
 */
export const POST = withAuth<Params>(
  { permission: 'media:update', name: 'POST /api/v1/orgs/{orgSlug}/media/move' },
  async ({ request, ctx }) => {
    const input = await readJsonBody(request, moveSchema);

    return jsonOk(await moveAssets(ctx, input, requestFingerprint(request)));
  },
);
