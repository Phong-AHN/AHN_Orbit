import { assertCan } from '@orbit/rbac';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { aiProvider } from '@/server/ai-provider';
import { generateIdeasSchema } from '@/features/ideas/contracts';
import { generateIdeas } from '@/features/ideas/generate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Params = { orgSlug: string };

/**
 * Ask the model for content ideas and save them as suggestions (D-109 §8.1).
 *
 * Two rights, both on the brand: making ideas (`post:create`, as for one typed
 * by hand) and spending AI (`ai:generate`). Nothing here creates a post.
 */
export const POST = withAuth<Params>(
  {
    permission: 'post:create',
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
    name: 'POST /api/v1/orgs/{orgSlug}/content-ideas/generate',
  },
  async ({ request, ctx }) => {
    const input = await readJsonBody(request, generateIdeasSchema);
    assertCan(ctx, 'ai:generate', { workspaceId: input.workspaceId, brandId: input.brandId });
    return jsonOk(await generateIdeas(ctx, input, aiProvider(), requestFingerprint(request)), {
      status: 201,
    });
  },
);
