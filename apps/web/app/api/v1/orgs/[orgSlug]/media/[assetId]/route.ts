import { NextResponse } from 'next/server';
import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { deleteMediaAsset, getMediaAsset } from '@/features/media/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; assetId: string };

export const GET = withAuth<Params>(
  { permission: 'media:read', name: 'GET /api/v1/orgs/{orgSlug}/media/{assetId}' },
  async ({ ctx, params }) => jsonOk({ asset: await getMediaAsset(ctx, params.assetId) }),
);

export const DELETE = withAuth<Params>(
  { permission: 'media:delete', name: 'DELETE /api/v1/orgs/{orgSlug}/media/{assetId}' },
  async ({ request, ctx, params }) => {
    await deleteMediaAsset(ctx, params.assetId, requestFingerprint(request));
    return new NextResponse(null, { status: 204 });
  },
);
