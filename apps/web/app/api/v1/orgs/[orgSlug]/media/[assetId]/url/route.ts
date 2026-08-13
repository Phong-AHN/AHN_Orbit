import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { getMediaDownloadUrl } from '@/features/media/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; assetId: string };

/**
 * A short-lived signed URL, issued only after the RBAC check passes and only
 * for a key carrying this organization's prefix.
 */
export const GET = withAuth<Params>(
  { permission: 'media:read', name: 'GET /api/v1/orgs/{orgSlug}/media/{assetId}/url' },
  async ({ request, ctx, params }) => {
    const inline = new URL(request.url).searchParams.get('inline') === 'true';
    return jsonOk(await getMediaDownloadUrl(ctx, params.assetId, { inline }));
  },
);
