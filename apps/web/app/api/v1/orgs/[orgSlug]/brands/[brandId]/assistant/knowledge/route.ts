import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { knowledgeEntryInputSchema } from '@/features/assistant/contracts';
import { brandResourceScope } from '@/features/assistant/route-scope';
import { createKnowledgeEntry } from '@/features/assistant/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; brandId: string };

/** Add something the assistant may answer from (D-108). */
export const POST = withAuth<Params>(
  {
    permission: 'ai_assistant:manage',
    resource: brandResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/brands/{brandId}/assistant/knowledge',
  },
  async ({ request, ctx, params }) => {
    const input = await readJsonBody(request, knowledgeEntryInputSchema);

    return jsonOk(
      {
        entry: await createKnowledgeEntry(ctx, params.brandId, input, requestFingerprint(request)),
      },
      { status: 201 },
    );
  },
);
