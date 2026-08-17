import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { updateBrandVoiceSchema } from '@/features/brand-voice/contracts';
import { getBrandVoice, updateBrandVoice } from '@/features/brand-voice/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; brandId: string };

/**
 * Brand Brain (SRS §24).
 *
 * `brand_voice:read` / `brand_voice:update`, which exist separately from
 * `brand:*` for a reason worth preserving: a Content Creator and an Approver
 * are granted **read** on the voice and no update, so they can write on-brand
 * without being able to change what on-brand means. Guarding this with
 * `brand:update` would have quietly moved that line.
 *
 * `null` for a brand nobody has filled in — a distinct state from an empty one,
 * and the UI says so.
 */
export const GET = withAuth<Params>(
  {
    permission: 'brand_voice:read',
    resource: ({ params }) => ({ brandId: params.brandId }),
    name: 'GET /api/v1/orgs/{orgSlug}/brands/{brandId}/voice',
  },
  async ({ ctx, params }) => jsonOk({ voice: await getBrandVoice(ctx, params.brandId) }),
);

export const PUT = withAuth<Params>(
  {
    permission: 'brand_voice:update',
    resource: ({ params }) => ({ brandId: params.brandId }),
    name: 'PUT /api/v1/orgs/{orgSlug}/brands/{brandId}/voice',
  },
  async ({ request, ctx, params }) => {
    const input = await readJsonBody(request, updateBrandVoiceSchema);

    return jsonOk({
      voice: await updateBrandVoice(ctx, params.brandId, input, requestFingerprint(request)),
    });
  },
);
