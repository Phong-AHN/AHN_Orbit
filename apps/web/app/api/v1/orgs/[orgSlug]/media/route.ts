import { MEDIA_KINDS, type MediaKind } from '@orbit/core';
import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { listMedia, listMediaWithPreviews } from '@/features/media/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

export const GET = withAuth<Params>(
  {
    permission: 'media:read',
    resource: ({ request }) => {
      const url = new URL(request.url);
      const workspaceId = url.searchParams.get('workspaceId');
      const brandId = url.searchParams.get('brandId');
      return {
        ...(workspaceId ? { workspaceId } : {}),
        ...(brandId ? { brandId } : {}),
      };
    },
    name: 'GET /api/v1/orgs/{orgSlug}/media',
  },
  async ({ request, ctx }) => {
    const url = new URL(request.url);
    const kind = url.searchParams.get('kind');
    const search = url.searchParams.get('q');
    const workspaceId = url.searchParams.get('workspaceId');
    const brandId = url.searchParams.get('brandId');

    // Previews cost one local HMAC signature per row and are only wanted by a
    // surface that displays the images — the picker and the library page. A
    // caller that just needs ids and names does not pay for them.
    const list = url.searchParams.get('previews') === 'false' ? listMedia : listMediaWithPreviews;

    return jsonOk({
      assets: await list(ctx, {
        ...(workspaceId ? { workspaceId } : {}),
        ...(brandId ? { brandId } : {}),
        ...(search ? { search } : {}),
        ...(kind && (MEDIA_KINDS as readonly string[]).includes(kind)
          ? { kind: kind as MediaKind }
          : {}),
      }),
    });
  },
);
