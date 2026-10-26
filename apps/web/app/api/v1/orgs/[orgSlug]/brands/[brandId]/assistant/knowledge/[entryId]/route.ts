import { NextResponse } from 'next/server';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { knowledgeEntryUpdateSchema } from '@/features/assistant/contracts';
import { brandResourceScope } from '@/features/assistant/route-scope';
import { deleteKnowledgeEntry, updateKnowledgeEntry } from '@/features/assistant/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; brandId: string; entryId: string };

/** Change or remove one knowledge entry (D-108). Looked up within the brand. */
export const PATCH = withAuth<Params>(
  {
    permission: 'ai_assistant:manage',
    resource: brandResourceScope,
    name: 'PATCH /api/v1/orgs/{orgSlug}/brands/{brandId}/assistant/knowledge/{entryId}',
  },
  async ({ request, ctx, params }) => {
    const input = await readJsonBody(request, knowledgeEntryUpdateSchema);

    return jsonOk({
      entry: await updateKnowledgeEntry(
        ctx,
        params.brandId,
        params.entryId,
        input,
        requestFingerprint(request),
      ),
    });
  },
);

export const DELETE = withAuth<Params>(
  {
    permission: 'ai_assistant:manage',
    resource: brandResourceScope,
    name: 'DELETE /api/v1/orgs/{orgSlug}/brands/{brandId}/assistant/knowledge/{entryId}',
  },
  async ({ request, ctx, params }) => {
    await deleteKnowledgeEntry(ctx, params.brandId, params.entryId, requestFingerprint(request));
    return new NextResponse(null, { status: 204 });
  },
);
