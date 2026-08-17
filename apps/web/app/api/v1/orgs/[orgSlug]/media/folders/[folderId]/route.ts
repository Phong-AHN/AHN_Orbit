import { z } from 'zod';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { deleteFolder, renameFolder } from '@/features/media/folders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; folderId: string };

const renameSchema = z.object({ name: z.string().trim().min(1).max(120) });

export const PATCH = withAuth<Params>(
  { permission: 'media:update', name: 'PATCH /api/v1/orgs/{orgSlug}/media/folders/{folderId}' },
  async ({ request, ctx, params }) => {
    const { name } = await readJsonBody(request, renameSchema);

    return jsonOk({
      folder: await renameFolder(ctx, params.folderId, name, requestFingerprint(request)),
    });
  },
);

/**
 * Remove a folder, keeping everything that was in it.
 *
 * `media:update` rather than `media:delete`: nothing is deleted. The contents
 * move up to the parent and the folder goes — a folder is a label, and removing
 * a label must not destroy what it was attached to. The response says how many
 * things moved, because "where did my files go" is the question this answers.
 */
export const DELETE = withAuth<Params>(
  { permission: 'media:update', name: 'DELETE /api/v1/orgs/{orgSlug}/media/folders/{folderId}' },
  async ({ request, ctx, params }) =>
    jsonOk(await deleteFolder(ctx, params.folderId, requestFingerprint(request))),
);
