import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { completeMediaUpload } from '@/features/media/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; assetId: string };

/**
 * Verify the uploaded bytes and mark the asset READY.
 *
 * Until this succeeds the asset is PENDING and cannot be attached to a post.
 */
export const POST = withAuth<Params>(
  { permission: 'media:upload', name: 'POST /api/v1/orgs/{orgSlug}/media/{assetId}/complete' },
  async ({ request, ctx, params }) =>
    jsonOk({ asset: await completeMediaUpload(ctx, params.assetId, requestFingerprint(request)) }),
);
