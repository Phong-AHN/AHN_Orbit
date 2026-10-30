import { assertCan } from '@orbit/rbac';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { aiProvider } from '@/server/ai-provider';
import { generateImage, generateImageSchema } from '@/features/media/generate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

type Params = { orgSlug: string };

/**
 * Generate an image into the media library (D-110).
 *
 * Two rights on the brand, as for any AI write: putting media in the library
 * (`media:upload`, as for an upload) and spending AI (`ai:generate`). The image
 * is verified like an upload and attached to a post separately.
 */
export const POST = withAuth<Params>(
  {
    permission: 'media:upload',
    resource: async ({ request }) => {
      const body = (await request
        .clone()
        .json()
        .catch(() => ({}))) as { workspaceId?: unknown; brandId?: unknown };
      return {
        ...(typeof body.workspaceId === 'string' ? { workspaceId: body.workspaceId } : {}),
        ...(typeof body.brandId === 'string' ? { brandId: body.brandId } : {}),
      };
    },
    name: 'POST /api/v1/orgs/{orgSlug}/media/generate',
  },
  async ({ request, ctx }) => {
    const input = await readJsonBody(request, generateImageSchema);
    assertCan(ctx, 'ai:generate', { workspaceId: input.workspaceId, brandId: input.brandId });
    return jsonOk(await generateImage(ctx, input, aiProvider(), requestFingerprint(request)), {
      status: 201,
    });
  },
);
