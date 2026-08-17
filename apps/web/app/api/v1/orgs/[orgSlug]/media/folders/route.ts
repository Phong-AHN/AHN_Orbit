import { z } from 'zod';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { createFolder, listFolders } from '@/features/media/folders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

const createFolderSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  parentId: z.string().uuid().optional(),
});

/**
 * Media folders (SRS §12).
 *
 * Scoped to a workspace rather than a brand: agencies file by campaign and by
 * shoot, and both routinely span the brands belonging to one client.
 *
 * Guarded by `media:read` / `media:upload` — organising the library is part of
 * putting things in it, not a separate right.
 */
export const GET = withAuth<Params>(
  {
    permission: 'media:read',
    resource: ({ request }) => {
      const workspaceId = new URL(request.url).searchParams.get('workspaceId');
      return workspaceId ? { workspaceId } : {};
    },
    name: 'GET /api/v1/orgs/{orgSlug}/media/folders',
  },
  async ({ request, ctx }) => {
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) return jsonOk({ folders: [] });

    return jsonOk({ folders: await listFolders(ctx, workspaceId) });
  },
);

export const POST = withAuth<Params>(
  {
    permission: 'media:upload',
    resource: async ({ request }) => {
      const body = await request
        .clone()
        .json()
        .catch(() => ({}));
      const workspaceId = (body as { workspaceId?: unknown }).workspaceId;
      return typeof workspaceId === 'string' ? { workspaceId } : {};
    },
    name: 'POST /api/v1/orgs/{orgSlug}/media/folders',
  },
  async ({ request, ctx }) => {
    const input = await readJsonBody(request, createFolderSchema);
    const folder = await createFolder(ctx, input, requestFingerprint(request));

    return jsonOk({ folder }, { status: 201 });
  },
);
