import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { assistantSettingsSchema } from '@/features/assistant/contracts';
import { brandResourceScope } from '@/features/assistant/route-scope';
import { getAssistant, updateAssistantSettings } from '@/features/assistant/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; brandId: string };

/**
 * A brand's AI assistant: its settings, knowledge and recent record (D-108).
 *
 * Switching on AUTO is refused by the service unless the caller holds the
 * permission organization-wide and the brand has had a week of suggestions.
 */
export const GET = withAuth<Params>(
  {
    permission: 'ai_assistant:manage',
    resource: brandResourceScope,
    name: 'GET /api/v1/orgs/{orgSlug}/brands/{brandId}/assistant',
  },
  async ({ ctx, params }) => jsonOk({ assistant: await getAssistant(ctx, params.brandId) }),
);

export const PUT = withAuth<Params>(
  {
    permission: 'ai_assistant:manage',
    resource: brandResourceScope,
    name: 'PUT /api/v1/orgs/{orgSlug}/brands/{brandId}/assistant',
  },
  async ({ request, ctx, params }) => {
    const input = await readJsonBody(request, assistantSettingsSchema);

    return jsonOk({
      settings: await updateAssistantSettings(
        ctx,
        params.brandId,
        input,
        requestFingerprint(request),
      ),
    });
  },
);
