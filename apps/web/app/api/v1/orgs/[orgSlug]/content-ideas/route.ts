import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { createIdeaSchema } from '@/features/ideas/contracts';
import { createIdea, listIdeas } from '@/features/ideas/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * Content ideas (docs/API.md §2.10).
 *
 * Guarded by `post:create` / `post:read` rather than an AI permission: an idea
 * is a note somebody wrote in a planning meeting, and most of them never
 * involve a model. Whoever may write content may write down what to write.
 */
export const GET = withAuth<Params>(
  {
    permission: 'post:read',
    resource: ({ request }) => {
      const params = new URL(request.url).searchParams;
      const workspaceId = params.get('workspaceId');
      const brandId = params.get('brandId');
      return {
        ...(workspaceId ? { workspaceId } : {}),
        ...(brandId ? { brandId } : {}),
      };
    },
    name: 'GET /api/v1/orgs/{orgSlug}/content-ideas',
  },
  async ({ request, ctx }) => {
    const params = new URL(request.url).searchParams;
    const state = params.get('state');

    return jsonOk({
      ideas: await listIdeas(ctx, {
        ...(params.get('workspaceId') ? { workspaceId: params.get('workspaceId')! } : {}),
        ...(params.get('brandId') ? { brandId: params.get('brandId')! } : {}),
        ...(params.get('q') ? { search: params.get('q')! } : {}),
        ...(state === 'SUGGESTED' ||
        state === 'ACCEPTED' ||
        state === 'DISMISSED' ||
        state === 'CONVERTED'
          ? { state }
          : {}),
      }),
    });
  },
);

export const POST = withAuth<Params>(
  {
    permission: 'post:create',
    resource: async ({ request }) => {
      const body = await request
        .clone()
        .json()
        .catch(() => ({}));
      const { workspaceId, brandId } = body as { workspaceId?: unknown; brandId?: unknown };
      return {
        ...(typeof workspaceId === 'string' ? { workspaceId } : {}),
        ...(typeof brandId === 'string' ? { brandId } : {}),
      };
    },
    name: 'POST /api/v1/orgs/{orgSlug}/content-ideas',
  },
  async ({ request, ctx }) => {
    const input = await readJsonBody(request, createIdeaSchema);
    const idea = await createIdea(ctx, input, requestFingerprint(request));

    return jsonOk({ idea }, { status: 201 });
  },
);
