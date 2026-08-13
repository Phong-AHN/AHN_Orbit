import { MEDIA_KINDS, type MediaKind } from '@orbit/core';
import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { listMedia } from '@/features/media/service';

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
    const workspaceId = url.searchParams.get('workspaceId');
    const brandId = url.searchParams.get('brandId');

    return jsonOk({
      assets: await listMedia(ctx, {
        ...(workspaceId ? { workspaceId } : {}),
        ...(brandId ? { brandId } : {}),
        ...(kind && (MEDIA_KINDS as readonly string[]).includes(kind)
          ? { kind: kind as MediaKind }
          : {}),
      }),
    });
  },
);
